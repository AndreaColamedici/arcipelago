(function(){
    try {
        var u = 'https://arcipelago-proxy.SUBDOMAIN.workers.dev/count';
        var path = location.pathname.replace(/\/+$/, '') || '/';
        var page = path.split('/').pop().replace('.html', '') || 'index';
        navigator.sendBeacon(u, JSON.stringify({p: page}));
    } catch(e) {}
})();
