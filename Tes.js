/**
 * DNS Hop Script v1.0
 * By: Farhan (海鹏 鸟神 / Hanzet22)
 * Purpose: DNS rotation via DoH (DNS-over-HTTPS)
 *          Multi-hop DNS — random resolver per session
 *          Proxy Cascade / Relay Routing via DNS layer
 * Host: GitHub Raw → PCAPdroid JS Injector
 * 
 * HOW IT WORKS:
 * 1. Pick random DoH resolver from pool (TW/JP/ID/SG)
 * 2. Inject dns-prefetch hints for all links on page
 * 3. Override fetch/XHR to log resolved endpoints
 * 4. Session-locked: same resolver for entire session
 * 5. Next session: different random resolver
 */

(function () {
    'use strict';

    const TAG = '[DNS-HOP]';

    function log(type, msg) {
        console.warn(TAG + ' [' + type + '] ' + msg);
    }

    // ─── DoH RESOLVER POOL ─────────────────────────────────
    // Public DoH servers per region
    // Format: { name, url, region }

    const DOH_POOL = [
        // ── GLOBAL ──
        { name: 'Cloudflare',       url: 'https://1.1.1.1/dns-query',              region: 'GLOBAL' },
        { name: 'Cloudflare-2',     url: 'https://1.0.0.1/dns-query',              region: 'GLOBAL' },
        { name: 'Google',           url: 'https://8.8.8.8/dns-query',              region: 'GLOBAL' },
        { name: 'Google-2',         url: 'https://8.8.4.4/dns-query',              region: 'GLOBAL' },
        { name: 'Quad9',            url: 'https://9.9.9.9/dns-query',              region: 'GLOBAL' },
        { name: 'AdGuard',          url: 'https://94.140.14.14/dns-query',         region: 'GLOBAL' },
        { name: 'NextDNS',          url: 'https://45.90.28.0/dns-query',           region: 'GLOBAL' },

        // ── TAIWAN ──
        { name: 'TW-HiNet-1',      url: 'https://168.95.1.1/dns-query',           region: 'TW' },
        { name: 'TW-HiNet-2',      url: 'https://168.95.192.1/dns-query',         region: 'TW' },
        { name: 'TW-Google-TW',    url: 'https://8.8.8.8/dns-query',              region: 'TW' },

        // ── JAPAN ──
        { name: 'JP-IIJ',          url: 'https://103.2.57.5/dns-query',           region: 'JP' },
        { name: 'JP-NTT',          url: 'https://129.250.35.250/dns-query',       region: 'JP' },

        // ── SINGAPORE ──
        { name: 'SG-Cloudflare',   url: 'https://1.1.1.1/dns-query',              region: 'SG' },
        { name: 'SG-Google',       url: 'https://8.8.8.8/dns-query',              region: 'SG' },

        // ── INDONESIA ──
        { name: 'ID-Cloudflare',   url: 'https://1.1.1.1/dns-query',              region: 'ID' },
        { name: 'ID-Google',       url: 'https://8.8.8.8/dns-query',              region: 'ID' },
    ];

    // ─── SESSION LOCK ───────────────────────────────────────
    // Pilih satu resolver per session — gak berubah ubah
    // selama di website yang sama

    var _sessionKey = 'dnshop_resolver_' + window.location.hostname;
    var _selectedResolver = null;

    function pickResolver() {
        // Cek apakah sudah ada resolver untuk session ini
        // Pakai in-memory karena localStorage diblokir full-blocker
        if (window.__dnsHopResolver) {
            return window.__dnsHopResolver;
        }

        // Pick random dari pool
        var idx = Math.floor(Math.random() * DOH_POOL.length);
        var resolver = DOH_POOL[idx];
        window.__dnsHopResolver = resolver;

        log('RESOLVER', 'Selected: ' + resolver.name + ' [' + resolver.region + '] → ' + resolver.url);
        return resolver;
    }

    _selectedResolver = pickResolver();

    // ─── DNS PREFETCH INJECTION ─────────────────────────────
    // Inject <link rel="dns-prefetch"> untuk semua domain di halaman
    // Browser akan resolve via sistem DNS dulu
    // Tapi kita hint resolver mana yang diprioritaskan

    function injectDNSPrefetch() {
        var domains = new Set();

        // Kumpulin semua domain dari links, scripts, images
        document.querySelectorAll('a[href], script[src], img[src], link[href], iframe[src]').forEach(function(el) {
            try {
                var url = el.href || el.src;
                if (url && url.startsWith('http')) {
                    var hostname = new URL(url).hostname;
                    if (hostname && hostname !== window.location.hostname) {
                        domains.add(hostname);
                    }
                }
            } catch(e) {}
        });

        // Inject prefetch hints
        domains.forEach(function(domain) {
            var link = document.createElement('link');
            link.rel = 'dns-prefetch';
            link.href = '//' + domain;
            document.head && document.head.appendChild(link);
        });

        if (domains.size > 0) {
            log('PREFETCH', 'Injected dns-prefetch for ' + domains.size + ' domains');
        }
    }

    // ─── DoH QUERY FUNCTION ─────────────────────────────────
    // Query DNS via DoH untuk domain tertentu
    // Returns: Promise<string[]> — list of IPs

    function queryDoH(domain, resolver) {
        var url = resolver.url + '?name=' + encodeURIComponent(domain) + '&type=A';
        return fetch(url, {
            headers: {
                'Accept': 'application/dns-json'
            }
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            var ips = [];
            if (data && data.Answer) {
                data.Answer.forEach(function(ans) {
                    if (ans.type === 1) { // A record
                        ips.push(ans.data);
                    }
                });
            }
            return ips;
        })
        .catch(function(e) {
            log('DOH_ERR', domain + ' → ' + e.message);
            return [];
        });
    }

    // ─── FETCH INTERCEPTOR ──────────────────────────────────
    // Log semua outgoing fetch + resolve domain via DoH dulu

    var _origFetch = window.fetch;
    window.fetch = function(input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        
        try {
            var hostname = new URL(url).hostname;
            if (hostname && !url.includes('dns-query')) {
                // Pre-resolve via selected DoH (async, non-blocking)
                queryDoH(hostname, _selectedResolver).then(function(ips) {
                    if (ips.length > 0) {
                        log('DOH_RESOLVED', hostname + ' → ' + ips[0] + 
                            ' [via ' + _selectedResolver.name + ']');
                    }
                });
            }
        } catch(e) {}

        return _origFetch.apply(this, arguments);
    };

    // ─── XHR INTERCEPTOR ────────────────────────────────────
    var _origXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        try {
            var hostname = new URL(url, window.location.href).hostname;
            if (hostname && hostname !== window.location.hostname) {
                queryDoH(hostname, _selectedResolver).then(function(ips) {
                    if (ips.length > 0) {
                        log('XHR_RESOLVED', hostname + ' → ' + ips[0] +
                            ' [via ' + _selectedResolver.name + ']');
                    }
                });
            }
        } catch(e) {}
        return _origXHROpen.apply(this, arguments);
    };

    // ─── MULTI-HOP SIMULATION ───────────────────────────────
    // Simulate proxy chaining via sequential DoH queries
    // Domain → Resolver 1 → Resolver 2 → Final IP

    function multiHopResolve(domain) {
        // Pilih 2 resolver random yang beda region
        var pool = DOH_POOL.filter(function(r) {
            return r.name !== _selectedResolver.name;
        });
        var hop2 = pool[Math.floor(Math.random() * pool.length)];

        log('MULTIHOP', 'Chain: ' + 
            _selectedResolver.name + ' → ' + 
            hop2.name + ' → ' + domain);

        // Hop 1
        return queryDoH(domain, _selectedResolver)
            .then(function(ips1) {
                log('HOP1', domain + ' resolved: ' + (ips1[0] || 'none'));
                // Hop 2 — verify dengan resolver berbeda
                return queryDoH(domain, hop2).then(function(ips2) {
                    log('HOP2', domain + ' verified: ' + (ips2[0] || 'none'));
                    return { hop1: ips1, hop2: ips2, domain: domain };
                });
            });
    }

    // ─── INIT ───────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectDNSPrefetch);
    } else {
        injectDNSPrefetch();
    }

    window.addEventListener('load', injectDNSPrefetch);

    // ─── EXPOSE TOOLS ───────────────────────────────────────
    window.__dnsHopLog = [];
    var _origWarn = console.warn;
    console.warn = function() {
        var msg = Array.from(arguments).join(' ');
        if (msg.startsWith(TAG)) {
            window.__dnsHopLog.push({ time: new Date().toISOString(), msg: msg });
        }
        _origWarn.apply(console, arguments);
    };

    // Manual tools
    window.__showDNSLog = function() {
        console.table(window.__dnsHopLog);
        return window.__dnsHopLog;
    };

    window.__currentResolver = function() {
        console.log(TAG + ' Active resolver: ' + 
            _selectedResolver.name + ' [' + 
            _selectedResolver.region + '] → ' + 
            _selectedResolver.url);
        return _selectedResolver;
    };

    window.__rotateResolver = function() {
        window.__dnsHopResolver = null;
        _selectedResolver = pickResolver();
        log('ROTATE', 'New resolver: ' + _selectedResolver.name);
        return _selectedResolver;
    };

    window.__multiHop = function(domain) {
        return multiHopResolve(domain || window.location.hostname);
    };

    log('INIT', 'DNS-Hop v1.0 ACTIVE');
    log('RESOLVER', 'Session resolver: ' + _selectedResolver.name + 
        ' [' + _selectedResolver.region + ']');
    console.info(TAG + ' v1.0 | Commands: __showDNSLog() | __currentResolver() | __rotateResolver() | __multiHop(domain)');

})();
