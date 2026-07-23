(function(){
  'use strict';

  const raw=window.ENMACHO_ANALYTICS_CONFIG||{};
  const googleAnalyticsId=/^G-[A-Z0-9]+$/i.test(raw.googleAnalyticsId||'')
    ?String(raw.googleAnalyticsId).toUpperCase():'';
  const clarityProjectId=/^[a-z0-9]+$/i.test(raw.clarityProjectId||'')
    ?String(raw.clarityProjectId).toLowerCase():'';
  let loaded=false;
  if(!googleAnalyticsId&&!clarityProjectId)return;

  window.enmachoAnalytics=Object.freeze({
    track
  });

  loadProviders();

  document.addEventListener('click',event=>{
    const target=event.target instanceof Element
      ?event.target.closest('[data-analytics-event]'):null;
    if(!target)return;
    track(target.dataset.analyticsEvent,{
      placement:target.dataset.analyticsPlacement||'unknown'
    });
  });

  function loadProviders(){
    if(loaded)return;
    loaded=true;
    if(googleAnalyticsId)loadGoogleAnalytics();
    if(clarityProjectId)loadClarity();
  }

  function loadGoogleAnalytics(){
    window.dataLayer=window.dataLayer||[];
    window.gtag=window.gtag||function(){window.dataLayer.push(arguments);};
    window.gtag('js',new Date());
    window.gtag('config',googleAnalyticsId,{
      allow_google_signals:false,
      allow_ad_personalization_signals:false
    });
    const script=document.createElement('script');
    script.async=true;
    script.src=`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(googleAnalyticsId)}`;
    document.head.appendChild(script);
  }

  function loadClarity(){
    window.clarity=window.clarity||function(){
      (window.clarity.q=window.clarity.q||[]).push(arguments);
    };
    const script=document.createElement('script');
    script.async=true;
    script.src=`https://www.clarity.ms/tag/${encodeURIComponent(clarityProjectId)}`;
    document.head.appendChild(script);
  }

  function track(name,parameters={}){
    if(!/^[a-z][a-z0-9_]{0,39}$/i.test(name||''))return;
    const safe={};
    for(const [key,value] of Object.entries(parameters)){
      if(!/^[a-z][a-z0-9_]{0,39}$/i.test(key))continue;
      if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')
        safe[key]=typeof value==='string'?value.slice(0,100):value;
    }
    if(typeof window.gtag==='function')window.gtag('event',name,safe);
    if(typeof window.clarity==='function')window.clarity('event',name);
  }

})();
