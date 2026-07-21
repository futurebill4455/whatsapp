(function () {
  function statusClass(status) {
    return 'status-' + (status || 'disconnected');
  }

  window.InsuranceApp = {
    connectWhatsAppStatus: function (opts) {
      if (typeof io === 'undefined') return;

      var socket = io({ transports: ['websocket', 'polling'] });
      var statusEl = document.querySelector(opts.statusSelector);
      var qrEl = document.querySelector(opts.qrSelector);
      var qrWrap = document.querySelector(opts.qrWrapSelector);
      var infoEl = document.querySelector(opts.infoSelector);
      var dotEl = document.querySelector(opts.dotSelector);
      var placeholderEl = document.querySelector(opts.placeholderSelector || '#qr-placeholder');
      var readyEl = document.querySelector(opts.readySelector || '#ready-wrap');
      var lastSeq = -1;

      function showPlaceholder(text) {
        if (qrEl) {
          qrEl.removeAttribute('src');
          qrEl.classList.add('hidden');
        }
        if (placeholderEl) {
          placeholderEl.classList.remove('hidden');
          if (text) placeholderEl.textContent = text;
        }
      }

      function showQr(dataUrl) {
        if (!qrEl || !dataUrl) return;
        qrEl.src = dataUrl;
        qrEl.classList.remove('hidden');
        if (placeholderEl) placeholderEl.classList.add('hidden');
        if (qrWrap) qrWrap.classList.remove('hidden');
        if (readyEl) readyEl.classList.add('hidden');
      }

      function applyStatus(data) {
        if (!data) return;
        if (statusEl) statusEl.textContent = (data.status || 'unknown').replace(/_/g, ' ');
        if (dotEl) dotEl.className = 'status-dot ' + statusClass(data.status);

        if (infoEl) {
          if (data.info && data.info.phone) {
            infoEl.textContent =
              'Connected as +' +
              data.info.phone +
              (data.info.pushname ? ' (' + data.info.pushname + ')' : '');
          } else if (data.status === 'qr') {
            infoEl.textContent = 'Scan the latest QR within ~20 seconds (Linked devices → Link a device)';
          } else if (data.status === 'loading' || data.status === 'authenticated') {
            infoEl.textContent = 'Link accepted — finishing handshake… keep this page open';
          } else if (data.status === 'resetting') {
            infoEl.textContent = 'Clearing old session and generating a fresh QR…';
          } else if (data.lastError) {
            infoEl.textContent = 'Error: ' + data.lastError;
          } else {
            infoEl.textContent = 'Waiting for connection…';
          }
        }

        if (data.ready) {
          if (qrWrap) qrWrap.classList.add('hidden');
          if (readyEl) readyEl.classList.remove('hidden');
        } else if (data.status === 'qr' && data.qr) {
          if (typeof data.qrSeq === 'number' && data.qrSeq < lastSeq) return;
          lastSeq = data.qrSeq || lastSeq;
          showQr(data.qr);
        }
      }

      socket.on('whatsapp:status', applyStatus);

      socket.on('whatsapp:qr', function (payload) {
        if (!payload) return;
        if (typeof payload.seq === 'number') {
          if (payload.seq < lastSeq) return;
          lastSeq = payload.seq;
        }

        if (payload.clearing || !payload.qr) {
          showPlaceholder(payload.reason === 'refreshing' ? 'Refreshing QR…' : 'Generating QR…');
          if (qrWrap) qrWrap.classList.remove('hidden');
          if (readyEl) readyEl.classList.add('hidden');
          return;
        }

        showQr(payload.qr);
      });

      return socket;
    },
  };
})();
