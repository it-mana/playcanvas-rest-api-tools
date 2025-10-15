(function () {
    'use strict';

    // ============================================================================
    // DRACO DECODER INLINE LOADER - ZERO NETWORK REQUESTS
    // ============================================================================
    // This patch embeds Draco WASM decoder and provides offline initialization.
    // It intercepts PlayCanvas's Draco module loading to inject inlined resources.
    // WASM-first with automatic ASM.js fallback if WebAssembly is unavailable.
    // ============================================================================

    // Global state for Draco decoder initialization
    window.__DRACO_DECODER_STATE__ = {
        wasmBinary: null,           // Inline WASM bytes
        decoderModule: null,        // Initialized Draco decoder
        initPromise: null,          // Initialization promise
        isReady: false,             // Ready flag
        useWasm: typeof WebAssembly !== 'undefined'  // WASM capability detection
    };

    // ============================================================================
    // STEP 1: Override Draco Module Locator (for draco.wasm.js)
    // ============================================================================
    // This runs BEFORE draco.wasm.js loads. When Draco's glue code tries to
    // locate the WASM file, we provide the inline bytes instead of a URL.
    // ============================================================================
    
    var DracoDecoderModule = window.DracoDecoderModule || {};
    
    // Get WASM binary from global variable set before draco.wasm.js loads
    if (window.__DRACO_WASM_BINARY__) {
        DracoDecoderModule.wasmBinary = window.__DRACO_WASM_BINARY__;
        console.log('[Draco] WASM binary attached to module (' + 
            DracoDecoderModule.wasmBinary.byteLength + ' bytes)');
    } else {
        // Placeholder, may be replaced at build time
        DracoDecoderModule.wasmBinary = null;
    }
    
    // Override locateFile to prevent any network fetch attempts
    DracoDecoderModule.locateFile = function(path, scriptDirectory) {
        console.log('[Draco] locateFile called for:', path, '- returning inline data');
        
        // Always return empty string - we provide wasmBinary directly
        return '';
    };

        // Disable Emscripten's default fetch mechanisms
    DracoDecoderModule.instantiateWasm = function(imports, successCallback) {
        var wasmBinary = DracoDecoderModule.wasmBinary || window.__DRACO_WASM_BINARY__;
        
        if (!wasmBinary) {
            console.error('[Draco] WASM binary not available - check if WASM was embedded correctly');
            console.error('[Draco] Checked DracoDecoderModule.wasmBinary and __DRACO_WASM_BINARY__');
            return {};
        }

        console.log('[Draco] Instantiating WASM from inline bytes (' + wasmBinary.byteLength + ' bytes)');
        
        // Instantiate WASM from our inline bytes
        WebAssembly.instantiate(wasmBinary, imports).then(function(output) {
            console.log('[Draco] WASM instantiation successful');
            successCallback(output.instance, output.module);
        }).catch(function(err) {
            console.error('[Draco] WASM instantiation failed:', err);
        });
        
        return {}; // Signal that we're handling instantiation
    };

    // Store the module config globally for draco.wasm.js to pick up
    window.DracoDecoderModule = DracoDecoderModule;

    // ============================================================================
    // STEP 2: Draco Initialization Helper
    // ============================================================================
    
    /**
     * Initialize Draco decoder with inline resources
     * Returns a promise that resolves when decoder is ready
     */
    window.initDracoDecoder = function() {
        var state = window.__DRACO_DECODER_STATE__;
        
        // Return existing promise if already initializing/initialized
        if (state.initPromise) {
            return state.initPromise;
        }

        console.log('[Draco] Initializing decoder (WASM: ' + state.useWasm + ')');

        state.initPromise = new Promise(function(resolve, reject) {
            try {
                // The DracoDecoderModule function is loaded from draco.wasm.js or draco.js
                if (typeof DracoDecoderModule !== 'function' && typeof window.DracoDecoderModule !== 'object') {
                    throw new Error('DracoDecoderModule not loaded');
                }

                // Initialize the module
                var moduleConfig = window.DracoDecoderModule || DracoDecoderModule;
                
                // For WASM version, the module is a factory function
                if (typeof DracoDecoderModule === 'function') {
                    DracoDecoderModule(moduleConfig).then(function(module) {
                        console.log('[Draco] Decoder module initialized');
                        state.decoderModule = module;
                        state.isReady = true;
                        
                        // DON'T overwrite DracoDecoderModule - workers need the factory function!
                        // Instead, store the initialized module separately
                        window.__DRACO_INITIALIZED_MODULE__ = module;
                        console.log('[Draco] Initialized module stored as window.__DRACO_INITIALIZED_MODULE__');
                        
                        resolve(module);
                    }).catch(reject);
                } else {
                    // ASM.js fallback - module is already the decoder
                    console.log('[Draco] Using ASM.js decoder');
                    state.decoderModule = moduleConfig;
                    state.isReady = true;
                    resolve(moduleConfig);
                }
            } catch (err) {
                console.error('[Draco] Initialization failed:', err);
                reject(err);
            }
        });

        return state.initPromise;
    };

    // ============================================================================
    // STEP 3: Patch PlayCanvas Asset Loading & Draco Module Resolution
    // ============================================================================
    // Ensure Draco decoder is initialized BEFORE PlayCanvas tries to decode GLBs
    // Also intercept any attempts to load draco.wasm.js or draco.wasm.wasm
    // ============================================================================

    /**
     * Create blob URLs for Draco files so workers can importScripts() them
     */
    (function() {
        // Create blob URL for draco.wasm.js
        if (window.__DRACO_DECODER_CODE__) {
            var decoderBlob = new Blob([window.__DRACO_DECODER_CODE__], { type: 'application/javascript' });
            window.__DRACO_DECODER_BLOB_URL__ = URL.createObjectURL(decoderBlob);
            console.log('[Draco] Created blob URL for decoder:', window.__DRACO_DECODER_BLOB_URL__);
        }
        
        // Create blob URL for draco.wasm.wasm
        if (window.__DRACO_WASM_BINARY__) {
            var wasmBlob = new Blob([window.__DRACO_WASM_BINARY__], { type: 'application/wasm' });
            window.__DRACO_WASM_BLOB_URL__ = URL.createObjectURL(wasmBlob);
            console.log('[Draco] Created blob URL for WASM:', window.__DRACO_WASM_BLOB_URL__);
        }
    })();

    /**
     * Intercept Blob constructor to modify worker scripts
     */
    (function() {
        var OriginalBlob = window.Blob;
        window.Blob = function(parts, options) {
            // Check if this looks like a worker script
            if (options && options.type === 'application/javascript' && parts && parts.length > 0) {
                var code = parts[0];
                if (typeof code === 'string' && code.indexOf('DracoDecoderModule') !== -1) {
                    console.log('[Draco] Intercepting worker blob creation');
                    
                    // Instead of replacing paths, inject the decoder code directly at the top
                    var injectedCode = '';
                    
                    // STEP 1: Set up Module config BEFORE decoder loads
                    if (window.__DRACO_WASM_BLOB_URL__) {
                        injectedCode += '// Module config for WASM loading\n';
                        injectedCode += 'var Module = Module || {};\n';
                        injectedCode += 'Module.locateFile = function(path) {\n';
                        injectedCode += '  if (path.indexOf("draco") !== -1 || path.indexOf(".wasm") !== -1) {\n';
                        injectedCode += '    return "' + window.__DRACO_WASM_BLOB_URL__ + '";\n';
                        injectedCode += '  }\n';
                        injectedCode += '  return path;\n';
                        injectedCode += '};\n\n';
                        console.log('[Draco] Injected Module.locateFile before decoder');
                    }
                    
                    // STEP 2: Add the decoder module code and ensure it's globally accessible
                    if (window.__DRACO_DECODER_CODE__) {
                        injectedCode += '// Embedded Draco Decoder Module\n';
                        injectedCode += '(function() {\n';
                        injectedCode += window.__DRACO_DECODER_CODE__ + '\n';
                        injectedCode += '// Ensure DracoDecoderModule is accessible globally in worker\n';
                        injectedCode += 'if (typeof DracoDecoderModule !== "undefined") {\n';
                        injectedCode += '  self.DracoDecoderModule = DracoDecoderModule;\n';
                        injectedCode += '}\n';
                        injectedCode += '})();\n\n';
                        console.log('[Draco] Injected decoder code into worker (' + window.__DRACO_DECODER_CODE__.length + ' bytes)');
                    }
                    
                    // Add the original worker code
                    injectedCode += '// Original Worker Code\n';
                    injectedCode += code;
                    
                    console.log('[Draco] Final worker code size:', injectedCode.length, 'bytes');
                    parts = [injectedCode];
                }
            }
            return new OriginalBlob(parts, options);
        };
        window.Blob.prototype = OriginalBlob.prototype;
    })();

    /**
     * Intercept Worker creation to patch importScripts and fetch inside workers
     */
    (function() {
        var OriginalWorker = window.Worker;
        window.Worker = function(scriptURL, options) {
            console.log('[Draco] Worker created with script:', scriptURL);
            
            var worker = new OriginalWorker(scriptURL, options);
            
            // Intercept messages from the worker to inject decoder
            var originalPostMessage = worker.postMessage.bind(worker);
            
            // Override the worker's importScripts and fetch via a message
            // Send initialization code to the worker
            setTimeout(function() {
                try {
                    // Try to inject decoder code into worker via eval
                    // This won't work directly, but we can send a message
                    if (window.__DRACO_DECODER_CODE__ && window.__DRACO_WASM_BINARY__) {
                        console.log('[Draco] Attempting to inject decoder into worker via message');
                        
                        // The worker script might listen for this
                        worker.postMessage({
                            type: 'init',
                            decoderCode: window.__DRACO_DECODER_CODE__,
                            wasmBinary: window.__DRACO_WASM_BINARY__
                        });
                    }
                } catch (e) {
                    console.warn('[Draco] Could not inject into worker:', e);
                }
            }, 0);
            
            return worker;
        };
        window.Worker.prototype = OriginalWorker.prototype;
    })();

    /**
     * Intercept fetch requests for Draco files
     */
    (function() {
        var originalFetch = window.fetch;
        window.fetch = function(url) {
            if (typeof url === 'string' && 
                (url.indexOf('draco.wasm.wasm') !== -1 || 
                 url.indexOf('draco.wasm.js') !== -1 || 
                 url.indexOf('draco.js') !== -1)) {
                console.log('[Draco] Intercepted fetch request for:', url);
                
                // Return the embedded WASM binary for .wasm files
                if (url.indexOf('draco.wasm.wasm') !== -1 || url.indexOf('draco_decoder.wasm') !== -1) {
                    console.log('[Draco] Redirecting WASM fetch to blob URL');
                    if (window.__DRACO_WASM_BLOB_URL__) {
                        // Redirect to blob URL
                        return originalFetch.call(this, window.__DRACO_WASM_BLOB_URL__);
                    } else if (window.__DRACO_WASM_BINARY__) {
                        // Fallback: return as Response
                        return Promise.resolve(new Response(window.__DRACO_WASM_BINARY__, {
                            status: 200,
                            statusText: 'OK',
                            headers: new Headers({'Content-Type': 'application/wasm'})
                        }));
                    } else {
                        console.error('[Draco] WASM binary not available!');
                        return Promise.reject(new Error('Draco WASM not embedded'));
                    }
                }
                
                // For .js files, return the decoder code
                if (url.indexOf('draco.wasm.js') !== -1 || url.indexOf('draco.js') !== -1) {
                    console.log('[Draco] Redirecting decoder JS fetch to blob URL');
                    if (window.__DRACO_DECODER_BLOB_URL__) {
                        // Redirect to blob URL
                        return originalFetch.call(this, window.__DRACO_DECODER_BLOB_URL__);
                    } else if (window.__DRACO_DECODER_CODE__) {
                        // Fallback: return as Response
                        return Promise.resolve(new Response(window.__DRACO_DECODER_CODE__, {
                            status: 200,
                            statusText: 'OK',
                            headers: new Headers({'Content-Type': 'text/javascript'})
                        }));
                    } else {
                        console.error('[Draco] Decoder code not available!');
                        return Promise.reject(new Error('Draco decoder not embedded'));
                    }
                }
                
                console.log('[Draco] Unknown Draco file requested:', url);
                return Promise.reject(new Error('Unknown Draco file'));
            }
            return originalFetch.apply(this, arguments);
        };
    })();

    /**
     * Intercept XMLHttpRequest for Draco files
     */
    (function() {
        var originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            if (typeof url === 'string' && 
                (url.indexOf('draco.wasm.wasm') !== -1 || 
                 url.indexOf('draco.wasm.js') !== -1 || 
                 url.indexOf('draco.js') !== -1)) {
                console.log('[Draco] Blocked XMLHttpRequest:', url);
                // Store flag to prevent send
                this.__dracoBlocked = true;
            }
            return originalOpen.apply(this, arguments);
        };
        
        var originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function() {
            if (this.__dracoBlocked) {
                console.log('[Draco] Prevented send for blocked Draco request');
                // Trigger error
                setTimeout(() => {
                    if (this.onerror) {
                        this.onerror(new Error('Draco files are embedded inline'));
                    }
                }, 0);
                return;
            }
            return originalSend.apply(this, arguments);
        };
    })();

    /**
     * Intercept script loading for Draco files
     */
    (function() {
        // Override document.createElement to intercept script loading
        var originalCreateElement = document.createElement.bind(document);
        document.createElement = function(tagName) {
            var element = originalCreateElement(tagName);
            
            if (tagName.toLowerCase() === 'script') {
                var originalSetAttribute = element.setAttribute.bind(element);
                element.setAttribute = function(name, value) {
                    // Intercept src attribute for Draco files
                    if (name === 'src' && typeof value === 'string') {
                        if (value.indexOf('draco.wasm.js') !== -1 || 
                            value.indexOf('draco.js') !== -1) {
                            console.log('[Draco] Blocked external script load:', value);
                            // Don't set the src - the decoder is already inline
                            return;
                        }
                    }
                    return originalSetAttribute(name, value);
                };
                
                // Also intercept direct src assignment
                var srcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
                if (srcDescriptor && srcDescriptor.set) {
                    Object.defineProperty(element, 'src', {
                        set: function(value) {
                            if (typeof value === 'string' && 
                                (value.indexOf('draco.wasm.js') !== -1 || value.indexOf('draco.js') !== -1)) {
                                console.log('[Draco] Blocked external script src:', value);
                                return;
                            }
                            srcDescriptor.set.call(this, value);
                        },
                        get: srcDescriptor.get
                    });
                }
            }
            
            return element;
        };
    })();

    /**
     * Patch the asset handler to wait for Draco initialization
     */
    function patchAssetLoader() {
        // Wait for PlayCanvas engine to be available
        if (typeof pc === 'undefined' || !pc.Asset) {
            console.log('[Draco] PlayCanvas not yet loaded, deferring patch');
            setTimeout(patchAssetLoader, 100);
            return;
        }

        console.log('[Draco] Patching PlayCanvas asset loader for Draco support');

        // Check what's available
        console.log('[Draco] pc.GlbParser exists:', typeof pc.GlbParser !== 'undefined');
        console.log('[Draco] pc.ContainerHandler exists:', typeof pc.ContainerHandler !== 'undefined');

        // Patch ContainerHandler instead of GlbParser (which doesn't exist in minified engine)
        if (pc.ContainerHandler && pc.ContainerHandler.prototype) {
            console.log('[Draco] Patching ContainerHandler');
            
            // Patch the open method which is called when GLB data is loaded
            if (pc.ContainerHandler.prototype.open) {
                var originalOpen = pc.ContainerHandler.prototype.open;
                
                pc.ContainerHandler.prototype.open = function(url, data, asset) {
                    console.log('[Draco] ContainerHandler.open called for:', url);
                    
                    // Inject decoder module before parsing
                    if (window.__DRACO_DECODER_STATE__.isReady && window.__DRACO_DECODER_STATE__.decoderModule) {
                        console.log('[Draco] Injecting decoder module');
                        window.DracoDecoderModule = window.__DRACO_DECODER_STATE__.decoderModule;
                    } else {
                        console.warn('[Draco] Decoder not ready during parse!');
                    }
                    
                    return originalOpen.call(this, url, data, asset);
                };
            }
            
            // Also try patching _parse if it exists
            if (pc.ContainerHandler.prototype._parse) {
                var originalParse = pc.ContainerHandler.prototype._parse;
                
                pc.ContainerHandler.prototype._parse = function(data) {
                    console.log('[Draco] ContainerHandler._parse called');
                    
                    // Inject decoder module before parsing
                    if (window.__DRACO_DECODER_STATE__.isReady && window.__DRACO_DECODER_STATE__.decoderModule) {
                        console.log('[Draco] Injecting decoder module into _parse');
                        window.DracoDecoderModule = window.__DRACO_DECODER_STATE__.decoderModule;
                    }
                    
                    return originalParse.call(this, data);
                };
            }
        }

        // Also try GlbParser in case it exists in some versions
        if (pc.GlbParser && !pc.GlbParser.__draco_patched) {
            console.log('[Draco] Patching GlbParser');
            var GlbParser = pc.GlbParser;
            
            // Inject Draco decoder module into parser
            if (GlbParser.prototype && GlbParser.prototype.parse) {
                var originalParse = GlbParser.prototype.parse;
                
                GlbParser.prototype.parse = function(filename, data, callback) {
                    console.log('[Draco] GLB parse called for:', filename);
                    
                    // Inject our decoder module if needed
                    if (window.__DRACO_DECODER_STATE__.isReady && window.__DRACO_DECODER_STATE__.decoderModule) {
                        // Make decoder available to parser
                        console.log('[Draco] Injecting decoder module into parser');
                        window.DracoDecoderModule = window.__DRACO_DECODER_STATE__.decoderModule;
                    } else {
                        console.warn('[Draco] Decoder not ready during parse! State:', window.__DRACO_DECODER_STATE__.isReady);
                    }
                    
                    return originalParse.call(this, filename, data, callback);
                };
                
                GlbParser.__draco_patched = true;
            }
        }
    }

    // Start patching immediately
    patchAssetLoader();

    // ============================================================================
    // STEP 4: Auto-initialize on DOMContentLoaded
    // ============================================================================
    
    function autoInitDraco() {
        console.log('[Draco] Auto-initializing decoder');
        window.initDracoDecoder().catch(function(err) {
            console.error('[Draco] Auto-initialization failed:', err);
        });
    }

    // Initialize as soon as DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInitDraco);
    } else {
        // DOM already loaded
        setTimeout(autoInitDraco, 0);
    }

    // ============================================================================
    // STEP 5: Global error handler to catch Draco-related errors
    // ============================================================================
    
    window.addEventListener('unhandledrejection', function(event) {
        if (event.reason && (event.reason.message || '').indexOf('draco') !== -1) {
            console.error('[Draco] Unhandled promise rejection:', event.reason);
        }
    });
    
    window.addEventListener('error', function(event) {
        if (event.message && event.message.toLowerCase().indexOf('draco') !== -1) {
            console.error('[Draco] Global error:', event.message, event.error);
        }
    });

    console.log('[Draco] Inline decoder patch loaded');
})();
