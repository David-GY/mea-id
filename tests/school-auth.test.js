const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function fixture(){
 let session={user:{id:'uid-one'},access_token:'first-token'}, listener, options, provider, emailRequest, signOutOptions, deferred=[];
 const auth={getSession:async()=>({data:{session}}),onAuthStateChange:cb=>{listener=cb;return {data:{subscription:{unsubscribe(){}}}};},signOut:async options=>{signOutOptions=options;session=null;return {};},signInWithOAuth:async p=>{provider=p;return {};},signInWithOtp:async p=>{emailRequest=p;return {};},verifyOtp:async p=>({data:{session:{user:{id:'uid-one'},access_token:'email-token'}}})};
 const context=vm.createContext({console,URL,URLSearchParams,location:{origin:'https://david-gy.github.io',pathname:'/mea-id/'},setTimeout:cb=>deferred.push(cb),supabase:{createClient:(url,key,opts)=>{options={url,key,...opts};return {auth};}}});context.window=context;
 vm.runInContext(fs.readFileSync(require.resolve('../school-auth.js'),'utf8'),context);
 return {context,config:{url:'https://gxffeavbefmmycmvccsm.supabase.co',publishableKey:'sb_publishable_test'},setSession:s=>session=s,get options(){return options;},get provider(){return provider;},get emailRequest(){return emailRequest;},get signOutOptions(){return signOutOptions;},emit:s=>{session=s;listener('SIGNED_IN',s);},flush:()=>deferred.splice(0).forEach(f=>f())};
}
test('Supabase adapter rejects missing public key and secret or different-project configuration',async()=>{
 const f=fixture();for(const config of [null,{url:f.config.url},{...f.config,url:'https://other.supabase.co'},{...f.config,publishableKey:'sb_secret_private'}])await assert.rejects(f.context.MeaSchoolAuth.load(config));
});
test('Supabase adapter uses PKCE, exact callback and current-session access tokens',async()=>{
 const f=fixture(),auth=await f.context.MeaSchoolAuth.load(f.config);
 assert.equal(f.options.auth.flowType,'pkce');assert.equal(await auth.currentUser.getIdToken(),'first-token');
 const prior=auth.currentUser;f.setSession({user:{id:'uid-one'},access_token:'fresh-token'});assert.equal(await prior.getIdToken(),'fresh-token');
 f.setSession({user:{id:'uid-two'},access_token:'other-token'});await assert.rejects(prior.getIdToken(),/account changed/);
 await auth.startSignIn();assert.equal(f.provider.provider,'google');assert.equal(f.provider.options.redirectTo,'https://david-gy.github.io/mea-id/');
});
test('Supabase callback work is deferred and sign-out clears active identity',async()=>{
 const f=fixture(),auth=await f.context.MeaSchoolAuth.load(f.config);let observed;
 auth.onAuthStateChanged(user=>observed=user);f.emit({user:{id:'uid-two'},access_token:'second'});assert.equal(observed,undefined);f.flush();assert.equal(observed.uid,'uid-two');
 await auth.signOut();assert.equal(auth.currentUser,null);assert.equal(f.signOutOptions.scope,'local');
});

test('email verification validates school addresses and uses Supabase email OTP verification',async()=>{
 const f=fixture(),auth=await f.context.MeaSchoolAuth.load(f.config);
 await assert.rejects(auth.requestEmailCode('person@gmail.com'),/student.ateneo/);
 await auth.requestEmailCode(' Person@student.ateneo.edu ');assert.equal(f.emailRequest.email,'person@student.ateneo.edu');assert.equal(f.emailRequest.options.shouldCreateUser,true);
 await assert.rejects(auth.verifyEmailCode('person@student.ateneo.edu','bad'),/verification code/);
 const user=await auth.verifyEmailCode('person@student.ateneo.edu','123456');assert.equal(user.uid,'uid-one');
});


test('a restored session reaches a late subscriber without another sign-in event',async()=>{
 const f=fixture(),auth=await f.context.MeaSchoolAuth.load(f.config);let user;
 auth.onAuthStateChanged(value=>user=value);f.flush();assert.equal(user.uid,'uid-one');
});
test('OAuth exchange rejection is actionable and never displays the authorization code',async()=>{
 const f=fixture();let cleaned;
 f.context.location={href:'https://david-gy.github.io/mea-id/?error=server_error&error_description=Unable+to+exchange+external+code%3A+private-code',search:'?error=server_error&error_description=Unable+to+exchange+external+code%3A+private-code',hash:''};
 f.context.history={replaceState:(_,__,url)=>cleaned=url};
 assert.equal(f.context.MeaSchoolAuth.callbackPresent(),true);
 await assert.rejects(f.context.MeaSchoolAuth.load(f.config),error=>/matching secret/.test(error.message)&&!error.message.includes('private-code'));
 assert.equal(cleaned,'/mea-id/');
});
test('unsubscribing cancels queued initial session notifications',async()=>{
 const f=fixture(),auth=await f.context.MeaSchoolAuth.load(f.config);let called=false;
 const stop=auth.onAuthStateChanged(()=>called=true);stop();f.flush();assert.equal(called,false);
});
