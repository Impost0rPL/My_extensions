// content.js
(function () {
    'use strict';

    // ============================================================
    // 0. POMOCNICZE – zapis/odczyt ustawień
    // ============================================================
    const STORAGE_KEY = 'ogloc_minimap_layout';
    function loadLayout() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
        catch (e) { return {}; }
    }
    function saveLayout(obj) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); }
        catch (e) { /* ignore */ }
    }

    // ============================================================
    // 1. ODCZYT WSPÓŁRZĘDNYCH Z IFRAME
    // ============================================================
    function extractLatLngFromIframe(iframe) {
        if (!iframe.src) return null;
        try {
            const url = new URL(iframe.src);
            const locationParam = url.searchParams.get('location');
            if (locationParam) {
                const [lat, lng] = locationParam.split(',');
                if (lat && lng) return { lat, lng };
            }
            const llParam = url.searchParams.get('ll') || url.searchParams.get('q');
            if (llParam) {
                const [lat, lng] = llParam.split(',');
                if (lat && lng) return { lat, lng };
            }
        } catch (e) {
            console.warn('[OGLoc] Błąd parsowania URL iframe:', e);
        }
        return null;
    }

    // ============================================================
    // 2. REVERSE GEOCODING
    // ============================================================
    const geoCache = new Map();
    async function reverseGeocode(lat, lng) {
        const key = `${lat},${lng}`;
        if (geoCache.has(key)) return geoCache.get(key);
        const promise = (async () => {
            try {
                const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1&accept-language=pl`;
                const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                const addr = data.address || {};
                const result = {
                    country: addr.country || '',
                    state: addr.state || addr.region || '',
                    city: addr.city || addr.town || addr.village || addr.municipality || addr.county || '',
                    district: addr.suburb || addr.neighbourhood || addr.city_district || addr.district || addr.quarter || '',
                    display: data.display_name || ''
                };
                geoCache.set(key, result);
                return result;
            } catch (e) {
                const fallback = { country: '', state: '', city: '', district: '', display: '', error: true };
                geoCache.set(key, fallback);
                return fallback;
            }
        })();
        geoCache.set(key, promise);
        return promise;
    }

    // ============================================================
    // 3. TOAST
    // ============================================================
    function showToast(msg) {
        let toast = document.getElementById('ogloc-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'ogloc-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.classList.add('ogloc-toast-show');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => toast.classList.remove('ogloc-toast-show'), 3000);
    }

    // ============================================================
    // 4. MINI-MAPKA (Google Maps Embed)
    // ============================================================
    const DEFAULT_ZOOM = 13;
    let currentMinimapLat = null;
    let currentMinimapLng = null;
    let currentMinimapZoom = DEFAULT_ZOOM;
    let minimapOpen = false;
    let minimapCoords = null; // ostatnio wyświetlone współrzędne

    function isMobile() {
        return window.innerWidth <= 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    }

    function ensureMinimapExists() {
        if (document.getElementById('ogloc-minimap')) return;

        const layout = loadLayout();
        const mm = document.createElement('div');
        mm.id = 'ogloc-minimap';
        mm.style.display = 'none';

        const defaultW = isMobile() ? Math.min(320, window.innerWidth - 20) : 480;
        const defaultH = isMobile() ? Math.min(260, window.innerHeight - 120) : 380;
        const w = layout.w || defaultW;
        const h = layout.h || defaultH;
        const x = layout.x;
        const y = layout.y;

        if (x !== undefined && y !== undefined) {
            mm.style.left = x + 'px';
            mm.style.top = y + 'px';
            mm.style.right = 'auto';
            mm.style.bottom = 'auto';
        }
        mm.style.width = w + 'px';
        mm.style.height = h + 'px';

        mm.innerHTML = `
            <div class="ogloc-minimap-header" id="ogloc-minimap-header">
                <span>🗺️ Google Maps</span>
                <div class="ogloc-minimap-actions">
                    <button class="ogloc-minimap-btn" id="ogloc-minimap-zoom-in" title="Przybliż">＋</button>
                    <button class="ogloc-minimap-btn" id="ogloc-minimap-zoom-out" title="Oddal">－</button>
                    <button class="ogloc-minimap-btn" id="ogloc-minimap-reset" title="Resetuj rozmiar">↺</button>
                    <button class="ogloc-minimap-btn ogloc-minimap-close" id="ogloc-minimap-close" title="Zamknij">✕</button>
                </div>
            </div>
            <iframe id="ogloc-minimap-frame" src="about:blank" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>
            <div class="ogloc-resize-handle" id="ogloc-resize-handle" title="Zmień rozmiar"></div>
        `;
        document.body.appendChild(mm);

        mm.querySelector('#ogloc-minimap-close').onclick = (e) => {
            e.stopPropagation();
            hideMinimap();
        };
        mm.querySelector('#ogloc-minimap-zoom-in').onclick = (e) => {
            e.stopPropagation();
            changeZoom(1);
        };
        mm.querySelector('#ogloc-minimap-zoom-out').onclick = (e) => {
            e.stopPropagation();
            changeZoom(-1);
        };
        mm.querySelector('#ogloc-minimap-reset').onclick = (e) => {
            e.stopPropagation();
            resetMinimapLayout();
        };

        // Drag i resize – używają Pointer Events z pointer capture
        makeDraggable(mm, mm.querySelector('#ogloc-minimap-header'));
        makeResizable(mm, mm.querySelector('#ogloc-resize-handle'));

        window.addEventListener('resize', handleWindowResize);
    }

    function handleWindowResize() {
        const mm = document.getElementById('ogloc-minimap');
        if (!mm || mm.style.display === 'none') return;
        const rect = mm.getBoundingClientRect();
        const maxW = window.innerWidth - 20;
        const maxH = window.innerHeight - 20;
        if (rect.width > maxW) mm.style.width = maxW + 'px';
        if (rect.height > maxH) mm.style.height = maxH + 'px';
        if (rect.left + rect.width > window.innerWidth) {
            mm.style.left = Math.max(10, window.innerWidth - rect.width - 10) + 'px';
        }
        if (rect.top + rect.height > window.innerHeight) {
            mm.style.top = Math.max(10, window.innerHeight - rect.height - 10) + 'px';
        }
    }

    // ==== Przeciąganie okienka (Pointer Events) ====
    function makeDraggable(el, handle) {
        let dragging = false;
        let startX = 0, startY = 0, startLeft = 0, startTop = 0;

        const onDown = (e) => {
            // Ignoruj kliknięcia w przyciski nagłówka
            if (e.target.closest('button')) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = el.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;

            // KLUCZ: przechwycenie wskaźnika – wszystkie zdarzenia trafiają do handle
            try { handle.setPointerCapture(e.pointerId); } catch (_) {}
            // Wyłącz iframe, żeby nie pożerał ruchów myszki
            el.classList.add('ogloc-dragging');
            e.preventDefault();
        };

        const onMove = (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const maxLeft = window.innerWidth - el.offsetWidth - 5;
            const maxTop = window.innerHeight - el.offsetHeight - 5;
            const newLeft = Math.max(5, Math.min(startLeft + dx, maxLeft));
            const newTop = Math.max(5, Math.min(startTop + dy, maxTop));
            el.style.left = newLeft + 'px';
            el.style.top = newTop + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            e.preventDefault();
        };

        const onUp = (e) => {
            if (!dragging) return;
            dragging = false;
            try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
            el.classList.remove('ogloc-dragging');
            persistLayout();
        };

        handle.addEventListener('pointerdown', onDown);
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    }

    // ==== Zmiana rozmiaru (Pointer Events + pointer capture) ====
    function makeResizable(el, handle) {
        let resizing = false;
        let startX = 0, startY = 0, startW = 0, startH = 0, startLeft = 0, startTop = 0;

        const onDown = (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            resizing = true;
            startX = e.clientX;
            startY = e.clientY;
            startW = el.offsetWidth;
            startH = el.offsetHeight;
            const rect = el.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;

            // KLUCZ 1: przechwycenie wskaźnika
            try { handle.setPointerCapture(e.pointerId); } catch (_) {}
            // KLUCZ 2: wyłączenie iframe na czas resize
            el.classList.add('ogloc-resizing');
            e.preventDefault();
            e.stopPropagation();
        };

        const onMove = (e) => {
            if (!resizing) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            const minW = isMobile() ? 220 : 260;
            const minH = isMobile() ? 180 : 220;

            // Granice ekranu (żeby okno nie wyszło poza viewport)
            const maxW = window.innerWidth - startLeft - 5;
            const maxH = window.innerHeight - startTop - 5;

            const newW = Math.max(minW, Math.min(startW + dx, maxW));
            const newH = Math.max(minH, Math.min(startH + dy, maxH));

            el.style.width = newW + 'px';
            el.style.height = newH + 'px';
            e.preventDefault();
        };

        const onUp = (e) => {
            if (!resizing) return;
            resizing = false;
            try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
            el.classList.remove('ogloc-resizing');
            persistLayout();
            // Odśwież iframe raz po resize, żeby Google Maps dopasował układ
            refreshMinimap();
        };

        handle.addEventListener('pointerdown', onDown);
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    }

    function persistLayout() {
        const mm = document.getElementById('ogloc-minimap');
        if (!mm) return;
        const rect = mm.getBoundingClientRect();
        saveLayout({
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
        });
    }

    function resetMinimapLayout() {
        localStorage.removeItem(STORAGE_KEY);
        const mm = document.getElementById('ogloc-minimap');
        if (!mm) return;
        mm.style.left = '20px';
        mm.style.top = 'auto';
        mm.style.right = 'auto';
        mm.style.bottom = '20px';
        mm.style.width = (isMobile() ? Math.min(320, window.innerWidth - 20) : 480) + 'px';
        mm.style.height = (isMobile() ? Math.min(260, window.innerHeight - 120) : 380) + 'px';
        showToast('↺ Rozmiar i pozycja zresetowane');
    }

    // ==== Zoom Google Maps ====
    function buildGoogleMapsUrl(lat, lng, zoom) {
        const q = `${lat},${lng}`;
        return `https://www.google.com/maps?q=${q}&z=${zoom}&output=embed&hl=pl`;
    }

    function refreshMinimap() {
        const frame = document.getElementById('ogloc-minimap-frame');
        if (!frame || currentMinimapLat === null) return;
        frame.src = buildGoogleMapsUrl(currentMinimapLat, currentMinimapLng, currentMinimapZoom);
    }

    function changeZoom(delta) {
        currentMinimapZoom = Math.max(1, Math.min(21, currentMinimapZoom + delta));
        refreshMinimap();
    }

    function showMinimap(lat, lng) {
        ensureMinimapExists();
        const mm = document.getElementById('ogloc-minimap');
        const latN = parseFloat(lat);
        const lngN = parseFloat(lng);
        if (isNaN(latN) || isNaN(lngN)) return;
        currentMinimapLat = latN;
        currentMinimapLng = lngN;
        currentMinimapZoom = DEFAULT_ZOOM;
        minimapCoords = { lat: latN, lng: lngN };
        minimapOpen = true;
        mm.style.display = 'flex';
        refreshMinimap();
    }

    // Nowa funkcja: aktualizacja bez zamykania okna
    function updateMinimap(lat, lng) {
        if (!minimapOpen) return;
        const latN = parseFloat(lat);
        const lngN = parseFloat(lng);
        if (isNaN(latN) || isNaN(lngN)) return;
        // Jeśli współrzędne się nie zmieniły – nic nie rób
        if (minimapCoords && minimapCoords.lat === latN && minimapCoords.lng === lngN) return;

        minimapCoords = { lat: latN, lng: lngN };
        currentMinimapLat = latN;
        currentMinimapLng = lngN;
        // Reset zoomu, bo to nowa lokalizacja
        currentMinimapZoom = DEFAULT_ZOOM;
        refreshMinimap();
    }

    function hideMinimap() {
        const mm = document.getElementById('ogloc-minimap');
        const frame = document.getElementById('ogloc-minimap-frame');
        if (mm) mm.style.display = 'none';
        if (frame) frame.src = 'about:blank';
        minimapOpen = false;
        minimapCoords = null;
    }

    // ============================================================
    // 5. PANEL Z WSPÓŁRZĘDNYMI
    // ============================================================
    let panelVisible = true;
    let currentCoords = null;

    function createOrUpdateOverlay(lat, lng) {
        let overlay = document.getElementById('openguessr-locator-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'openguessr-locator-overlay';
            document.body.appendChild(overlay);
            overlay.innerHTML = `
                <div class="ogloc-title">📍 LocateNow</div>
                <div class="ogloc-coords">
                    <div><span class="ogloc-label">Szerokość:</span> <span class="ogloc-value" id="ogloc-lat"></span></div>
                    <div><span class="ogloc-label">Długość:</span> <span class="ogloc-value" id="ogloc-lng"></span></div>
                </div>
                <div class="ogloc-geo">
                    <div class="ogloc-geo-row"><span class="ogloc-label">Kraj:</span> <span class="ogloc-value" id="ogloc-country">…</span></div>
                    <div class="ogloc-geo-row"><span class="ogloc-label">Miasto:</span> <span class="ogloc-value" id="ogloc-city">…</span></div>
                    <div class="ogloc-geo-row"><span class="ogloc-label">Dzielnica:</span> <span class="ogloc-value" id="ogloc-district">…</span></div>
                </div>
                <div class="ogloc-actions">
                    <button class="ogloc-btn ogloc-btn-maps" id="ogloc-maps-btn">🗺️ Pokaż na mapie</button>
                    <button class="ogloc-btn ogloc-btn-copy" id="ogloc-copy-btn">📋 Kopiuj</button>
                </div>
            `;
            overlay.querySelector('#ogloc-maps-btn').onclick = (e) => {
                e.stopPropagation();
                if (!currentCoords) return;
                showMinimap(currentCoords.lat, currentCoords.lng);
            };
            overlay.querySelector('#ogloc-copy-btn').onclick = (e) => {
                e.stopPropagation();
                if (!currentCoords) return;
                navigator.clipboard.writeText(`${currentCoords.lat}, ${currentCoords.lng}`)
                    .then(() => showToast('✅ Skopiowano współrzędne!'))
                    .catch(() => showToast('❌ Nie udało się skopiować.'));
            };
        }

        const newContent = `${lat},${lng}`;
        if (overlay.dataset.coords === newContent) return;
        overlay.dataset.coords = newContent;
        currentCoords = { lat, lng };

        overlay.querySelector('#ogloc-lat').textContent = lat;
        overlay.querySelector('#ogloc-lng').textContent = lng;
        overlay.querySelector('#ogloc-country').textContent = '…';
        overlay.querySelector('#ogloc-city').textContent = '…';
        overlay.querySelector('#ogloc-district').textContent = '…';

        reverseGeocode(lat, lng).then(geo => {
            if (!currentCoords || currentCoords.lat !== lat || currentCoords.lng !== lng) return;
            const cEl = document.getElementById('ogloc-country');
            const mEl = document.getElementById('ogloc-city');
            const dEl = document.getElementById('ogloc-district');
            if (!cEl || !mEl || !dEl) return;
            cEl.textContent = geo.country || (geo.error ? 'błąd' : '—');
            mEl.textContent = geo.city || (geo.error ? 'błąd' : '—');
            dEl.textContent = geo.district || (geo.error ? 'błąd' : '—');
        });

        // AUTO-AKTUALIZACJA MINI-MAPKI przy nowej rundzie
        updateMinimap(lat, lng);

        overlay.style.display = panelVisible ? 'block' : 'none';
    }

    // ============================================================
    // 6. PRZYCISK UKRYWANIA
    // ============================================================
    function createToggleButton() {
        if (document.getElementById('ogloc-toggle-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'ogloc-toggle-btn';
        btn.textContent = '📍';
        btn.title = 'Pokaż/ukryj panel lokalizacji';
        btn.onclick = () => {
            panelVisible = !panelVisible;
            const overlay = document.getElementById('openguessr-locator-overlay');
            if (overlay) overlay.style.display = panelVisible ? 'block' : 'none';
            btn.textContent = panelVisible ? '📍' : '👁️';
        };
        document.body.appendChild(btn);
    }

    // ============================================================
    // 7. SKANOWANIE
    // ============================================================
    let isUpdating = false;
    function scanForCoordinates() {
        if (isUpdating) return;
        isUpdating = true;
        const iframes = document.querySelectorAll('iframe');
        iframes.forEach(iframe => {
            if (iframe.id === 'ogloc-minimap-frame') return;
            if (iframe.src && (iframe.src.includes('google.com/maps') || iframe.src.includes('google.com/maps/embed'))) {
                const coords = extractLatLngFromIframe(iframe);
                if (coords) createOrUpdateOverlay(coords.lat, coords.lng);
            }
        });
        isUpdating = false;
    }

    // ============================================================
    // 8. INICJALIZACJA
    // ============================================================
    window.addEventListener('load', () => {
        createToggleButton();
        ensureMinimapExists();
        scanForCoordinates();
        setInterval(scanForCoordinates, 2000);
    });

    const observer = new MutationObserver((mutations) => {
        const addedIframe = mutations.some(m =>
            Array.from(m.addedNodes).some(n =>
                n.tagName === 'IFRAME' && n.id !== 'ogloc-minimap-frame'
            )
        );
        if (addedIframe) scanForCoordinates();
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();