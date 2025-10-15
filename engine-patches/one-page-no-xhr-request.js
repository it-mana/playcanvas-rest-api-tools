(function () {
    // Patch out supportsImageBitmap as that doesn't load some images when XHR is also patched out
    // We override the setting in configure before we load assets
    var oldAppConfigure = pc.Application.prototype.configure;
    pc.Application.prototype.configure = function (json, callback) {
        this.graphicsDevice.supportsImageBitmap = false;
        oldAppConfigure.call(this, json, callback);
    };

    pc.Http.prototype.get = function get(url, options, callback) {
        if (typeof options === "function") {
            callback = options;
            options = {};
        }

        // Special handling for Draco decoder file requests
        // PlayCanvas may try to load these even though we've embedded them
        if (typeof url === 'string') {
            var isDracoFile = url.indexOf('draco.wasm.js') !== -1 || 
                             url.indexOf('draco.wasm.wasm') !== -1 || 
                             url.indexOf('draco.js') !== -1;
            
            if (isDracoFile) {
                // Return empty response - decoder is already embedded
                callback(null, '');
                return;
            }
        }

        // Validate data URL format
        if (!url.startsWith('data:')) {
            console.error('[XHR Patch] Invalid data URL format:', url.substring(0, 100));
            callback(new Error('Invalid data URL format'), null);
            return;
        }

        var index = url.indexOf(',');
        if (index === -1) {
            console.error('[XHR Patch] Data URL missing comma separator');
            callback(new Error('Invalid data URL'), null);
            return;
        }

        var mimeInfo = url.substring(5, index); // Skip "data:" prefix
        var base64 = url.slice(index + 1);
        var data = window.atob(base64);

        // Extract MIME type from the data URL
        var mimeType = mimeInfo.split(';')[0]; // Get MIME type before any parameters like 'base64'

        // Determine response type from MIME type or options
        var isJson = url.startsWith('data:application/json') || options.responseType === pc.Http.ResponseType.JSON;
        var isText = url.startsWith('data:text/plain') || url.startsWith('data:text/javascript');
        var isImage = url.startsWith('data:image/');
        var isWasm = url.startsWith('data:application/wasm') || mimeInfo.indexOf('wasm') !== -1;
        var isGlb = url.startsWith('data:application/octet-stream') || mimeInfo.indexOf('octet-stream') !== -1;

        if (isJson) {
            // Parse JSON
            data = JSON.parse(data);
        } else if (isText) {
            // Return as string
            // Data is already a string from atob
        } else {
            // Binary data (models, images, WASM, etc.)
            var len = data.length;
            var bytes = new Uint8Array(len);
            for (var i = 0; i < len; i++) {
                bytes[i] = data.charCodeAt(i);
            }
            data = bytes.buffer;

            // Special handling for different binary types
            if (isImage) {
                // Images need Blob wrapper with correct MIME type
                data = new Blob([data], { type: mimeType });
            } else if (isWasm) {
                // WASM files should remain as ArrayBuffer
                // PlayCanvas or Draco decoder will handle instantiation
            } else if (isGlb) {
                // GLB files
            }
            // GLB/Binary files remain as ArrayBuffer
        }

        callback(null, data);
    }
})();
