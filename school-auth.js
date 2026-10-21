/* Supabase Google OAuth adapter. Only a publishable/anon key belongs in app-config.js. */
(function(root) {
  let loading;
  let client;
  function callbackParams() {
    const query=new URLSearchParams(root.location.search || '');
    const hash=new URLSearchParams((root.location.hash || '').replace(/^#/,''));
    return {code:query.get('code'), error:query.get('error') || hash.get('error'), description:query.get('error_description') || hash.get('error_description') || ''};
  }
  function clearCallback() {
    if (!root.history?.replaceState || !root.location.href) return;
    const url=new URL(root.location.href);
    ['code','error','error_code','error_description'].forEach(k=>url.searchParams.delete(k));
    if (/(?:^#|&)(?:error|access_token|refresh_token)=/.test(url.hash)) url.hash='';
    root.history.replaceState(null,'',url.pathname+url.search+url.hash);
  }
  root.MeaSchoolAuth = {callbackPresent() {const p=callbackParams();return !!(p.code || p.error);},load(config) {
    if (loading) return loading;
    if (!config?.url || !config?.publishableKey) return Promise.reject(new Error('School sign-in needs the Supabase public key. Continue with your ID.'));
    if (config.url !== 'https://gxffeavbefmmycmvccsm.supabase.co' || /^sb_secret_/.test(config.publishableKey)) return Promise.reject(new Error('Invalid Supabase public configuration.'));
    loading = (async () => {
      const callback=callbackParams();
      if (callback.error) {
        clearCallback();
        throw new Error(/exchange external code/i.test(callback.description)
          ? 'Google sign-in failed before MEA received a session. An administrator must check the Google OAuth Client ID and matching secret in Supabase, then try again.'
          : 'Google sign-in was cancelled or rejected. Try again with your student.ateneo.edu account.');
      }
      if (!root.supabase?.createClient) await new Promise((resolve,reject) => {
        const s=document.createElement('script'); s.src='vendor/supabase-2.118.0.js';
        s.onload=resolve; s.onerror=()=>{s.remove();reject(new Error('Could not load school sign-in. Check your connection.'));}; document.head.append(s);
      });
      client ||= root.supabase.createClient(config.url,config.publishableKey,{auth:{flowType:'pkce',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
      let user=null;
      function adapt(session) {
        if (!session?.user) return null;
        const uid=session.user.id;
        return {uid,async getIdToken() {
          const {data,error}=await client.auth.getSession(); if(error)throw error;
          if (!data.session || data.session.user.id!==uid) throw new Error('School account changed. Reconnect before continuing.');
          return data.session.access_token;
        }};
      }
      const api={get currentUser(){return user;},async providerStatus(){ const r=await fetch(config.url+'/auth/v1/settings',{headers:{apikey:config.publishableKey}});if(!r.ok)throw new Error('Could not check school sign-in availability.');const settings=await r.json();return {google:settings.external?.google===true,email:settings.external?.email===true}; },async startSignIn(){
        const redirectTo=location.origin+location.pathname;
        const {error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo,queryParams:{prompt:'select_account',hd:'student.ateneo.edu'}}});
        if(error)throw error; return {redirecting:true};
      },async requestEmailCode(email){
        email=String(email || '').trim().toLowerCase();if(!/^[^\s@]+@student\.ateneo\.edu$/.test(email))throw new Error('Use your student.ateneo.edu email.');
        const {error}=await client.auth.signInWithOtp({email,options:{shouldCreateUser:true,emailRedirectTo:location.origin+location.pathname}});if(error)throw error;
      },async verifyEmailCode(email,token){
        if(!/^\d{6,10}$/.test(String(token).trim()))throw new Error('Enter the verification code from your email.');
        const {data,error}=await client.auth.verifyOtp({email:String(email).trim().toLowerCase(),token:String(token).trim(),type:'email'});if(error)throw error;user=adapt(data.session);return user;
      },async signOut(){const {error}=await client.auth.signOut({scope:'local'}); if(error)throw error;user=null;},onAuthStateChanged(callback){
        // Supabase warns against awaited auth calls inside its synchronous callback.
        let active=true, version=0;
        const publish=()=>{const current=++version;setTimeout(()=>{if(active && current===version)callback(user);},0);};
        const {data}=client.auth.onAuthStateChange((_event,session)=>{user=adapt(session);publish();});
        // The initial SDK event may precede this subscription while the script loads.
        publish();
        return ()=>{active=false;data.subscription.unsubscribe();};
      }};
      const initial=await client.auth.getSession();
      if(initial.error) {if(callback.code)clearCallback();throw Object.assign(new Error(callback.code ? 'Could not finish Google sign-in. Start again in this same browser.' : initial.error.message),{code:initial.error.code,status:initial.error.status});}
      user=adapt(initial.data.session);
      if(callback.code) {clearCallback();if(!user)throw new Error('Google returned without a session. Try signing in again in this same browser.');}
      return api;
    })().catch(e=>{loading=null;throw e;});
    return loading;
  }};
})(window);
