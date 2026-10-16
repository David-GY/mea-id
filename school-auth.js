/* Supabase Google OAuth adapter. Only a publishable/anon key belongs in app-config.js. */
(function(root) {
  let loading;
  root.MeaSchoolAuth = {load(config) {
    if (loading) return loading;
    if (!config?.url || !config?.publishableKey) return Promise.reject(new Error('School sign-in needs the Supabase public key. Continue with your ID.'));
    if (config.url !== 'https://gxffeavbefmmycmvccsm.supabase.co' || /^sb_secret_/.test(config.publishableKey)) return Promise.reject(new Error('Invalid Supabase public configuration.'));
    loading = (async () => {
      if (!root.supabase?.createClient) await new Promise((resolve,reject) => {
        const s=document.createElement('script'); s.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
        s.onload=resolve; s.onerror=()=>{s.remove();reject(new Error('Could not load school sign-in. Check your connection.'));}; document.head.append(s);
      });
      const client=root.supabase.createClient(config.url,config.publishableKey,{auth:{flowType:'pkce',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
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
      },async signOut(){const {error}=await client.auth.signOut(); if(error)throw error;user=null;},onAuthStateChanged(callback){
        // Supabase warns against awaited auth calls inside its synchronous callback.
        const {data}=client.auth.onAuthStateChange((_event,session)=>{user=adapt(session);setTimeout(()=>callback(user),0);});
        return ()=>data.subscription.unsubscribe();
      }};
      const initial=await client.auth.getSession(); if(initial.error)throw initial.error;user=adapt(initial.data.session);
      return api;
    })().catch(e=>{loading=null;throw e;});
    return loading;
  }};
})(window);
