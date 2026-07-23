(function(){
  'use strict';

  const raw=window.ENMACHO_ANALYTICS_CONFIG||{};
  const googleAnalyticsId=/^G-[A-Z0-9]+$/i.test(raw.googleAnalyticsId||'')
    ?String(raw.googleAnalyticsId).toUpperCase():'';
  const clarityProjectId=/^[a-z0-9]+$/i.test(raw.clarityProjectId||'')
    ?String(raw.clarityProjectId).toLowerCase():'';
  const providers=[
    googleAnalyticsId&&'Google Analytics',
    clarityProjectId&&'Microsoft Clarity'
  ].filter(Boolean);
  if(!providers.length)return;

  const storageKey=`enmacho_analytics_consent_${String(raw.consentVersion||'v1')}`;
  let consent=readConsent();
  let loaded=false;
  let panel=null;

  window.enmachoAnalytics=Object.freeze({
    getConsent:()=>consent,
    openPreferences:()=>showConsentPanel(true),
    setConsent:value=>setConsent(value===true),
    track
  });

  if(navigator.globalPrivacyControl===true||navigator.doNotTrack==='1'){
    consent='denied';
    writeConsent(consent);
    clearAnalyticsCookies();
    return;
  }

  if(consent==='granted')loadProviders();
  else if(consent!=='denied')whenReady(()=>showConsentPanel(false));

  document.addEventListener('click',event=>{
    const target=event.target instanceof Element
      ?event.target.closest('[data-analytics-event]'):null;
    if(!target)return;
    track(target.dataset.analyticsEvent,{
      placement:target.dataset.analyticsPlacement||'unknown'
    });
  });

  function readConsent(){
    try{return localStorage.getItem(storageKey)||'';}catch(_){return '';}
  }

  function writeConsent(value){
    try{localStorage.setItem(storageKey,value);}catch(_){}
  }

  function setConsent(granted){
    const wasLoaded=loaded;
    consent=granted?'granted':'denied';
    writeConsent(consent);
    panel?.remove();
    panel=null;
    if(granted)loadProviders();
    else{
      if(typeof window.clarity==='function')window.clarity('consentv2',{
        ad_Storage:'denied',
        analytics_Storage:'denied'
      });
      clearAnalyticsCookies();
      if(wasLoaded)location.reload();
    }
  }

  function loadProviders(){
    if(loaded||consent!=='granted')return;
    loaded=true;
    if(googleAnalyticsId)loadGoogleAnalytics();
    if(clarityProjectId)loadClarity();
  }

  function loadGoogleAnalytics(){
    window.dataLayer=window.dataLayer||[];
    window.gtag=window.gtag||function(){window.dataLayer.push(arguments);};
    window.gtag('consent','default',{
      analytics_storage:'denied',
      ad_storage:'denied',
      ad_user_data:'denied',
      ad_personalization:'denied',
      wait_for_update:500
    });
    window.gtag('consent','update',{analytics_storage:'granted'});
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
    window.clarity('consentv2',{
      ad_Storage:'denied',
      analytics_Storage:'granted'
    });
    const script=document.createElement('script');
    script.async=true;
    script.src=`https://www.clarity.ms/tag/${encodeURIComponent(clarityProjectId)}`;
    document.head.appendChild(script);
  }

  function track(name,parameters={}){
    if(consent!=='granted'||!/^[a-z][a-z0-9_]{0,39}$/i.test(name||''))return;
    const safe={};
    for(const [key,value] of Object.entries(parameters)){
      if(!/^[a-z][a-z0-9_]{0,39}$/i.test(key))continue;
      if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')
        safe[key]=typeof value==='string'?value.slice(0,100):value;
    }
    if(typeof window.gtag==='function')window.gtag('event',name,safe);
    if(typeof window.clarity==='function')window.clarity('event',name);
  }

  function showConsentPanel(isPreferences){
    panel?.remove();
    panel=document.createElement('section');
    panel.id='analyticsConsent';
    panel.setAttribute('role','dialog');
    panel.setAttribute('aria-label','アクセス解析の設定');
    panel.innerHTML=`
      <style>
        #analyticsConsent{position:fixed;z-index:2147483646;left:50%;bottom:max(16px,env(safe-area-inset-bottom));
          transform:translateX(-50%);width:min(680px,calc(100% - 28px));padding:18px 20px;
          color:#e8dcc4;background:rgba(14,12,9,.98);border:1px solid #6a5329;border-radius:7px;
          box-shadow:0 12px 44px rgba(0,0,0,.65);font-family:'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif;
          font-size:13px;line-height:1.75}
        #analyticsConsent b{display:block;margin-bottom:4px;color:#e8c76a;font-family:'Yu Mincho',serif;
          font-size:15px;letter-spacing:.08em}
        #analyticsConsent p{margin:0;color:#cfc2a0}
        #analyticsConsent a{color:#d5bd7a;text-decoration:underline}
        #analyticsConsent .analytics-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:13px}
        #analyticsConsent button{appearance:none;padding:8px 16px;border:1px solid #6a5329;border-radius:4px;
          color:#e8dcc4;background:#252016;cursor:pointer;font:inherit}
        #analyticsConsent button[data-accept]{border-color:#c9a24a;background:#6f2118;color:#fff4dc}
        #analyticsConsent button:focus-visible{outline:2px solid #e8c76a;outline-offset:2px}
        @media(max-width:520px){#analyticsConsent{padding:15px}
          #analyticsConsent .analytics-actions{justify-content:stretch}
          #analyticsConsent button{flex:1;padding:10px 8px}}
      </style>
      <b>アクセス解析について</b>
      <p>${providers.join(' と ')}を、サイト改善のために使用します。
        許可するまで解析タグは読み込みません。
        <a href="/privacy">プライバシーポリシー</a>で詳細を確認できます。</p>
      <div class="analytics-actions">
        <button type="button" data-deny>${isPreferences?'許可を取り消す':'拒否する'}</button>
        <button type="button" data-accept>許可する</button>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector('[data-deny]').addEventListener('click',()=>setConsent(false));
    panel.querySelector('[data-accept]').addEventListener('click',()=>setConsent(true));
    panel.querySelector(isPreferences&&consent==='granted'?'[data-deny]':'[data-accept]').focus();
  }

  function clearAnalyticsCookies(){
    for(const cookie of document.cookie.split(';')){
      const name=cookie.split('=')[0].trim();
      if(!/^(_ga|_gid|_gat|_clck|_clsk)/.test(name))continue;
      document.cookie=`${name}=; Max-Age=0; Path=/; SameSite=Lax`;
      document.cookie=`${name}=; Max-Age=0; Path=/; Domain=.enmacho.com; SameSite=Lax`;
    }
  }

  function whenReady(callback){
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',callback,{once:true});
    else callback();
  }
})();
