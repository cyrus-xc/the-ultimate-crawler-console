// Uses the Java bridge bundled with Frida 16.x (see runtime dependency lock).

// App-driven reads only. Reuses the original study's OkHttp observation point.
// peekBody may prefetch bytes; it does not consume or replace the original body.
const paths = new Set([
  '/api/sns/v10/note', '/api/sns/v1/note/imagefeed',
  '/api/sns/v4/note/videofeed', '/api/sns/v5/note/comment/list',
  '/api/sns/v3/note/comment/sub_comments',
]);
let shareTarget = null;
const observedShares = new Map();
function retainObservedShare(body, request, observationId) {
  if (!shareTarget || request.path !== shareTarget.path || !Array.isArray(body.data)) return;
  const notes = body.data.flatMap(group => Array.isArray(group?.note_list) ? group.note_list : [])
    .filter(note => note?.id === shareTarget.noteId);
  if (notes.length === 1 && typeof notes[0].share_info?.link === 'string' && observedShares.size < 20) {
    observedShares.set(observationId, notes[0].share_info.link);
  }
}
rpc.exports = {
  allowshare(noteId, path) {
    if (!/^[a-f0-9]{24}$/.test(noteId) || !paths.has(path)) throw new Error('INVALID_SHARE_TARGET');
    shareTarget = {noteId, path};
    observedShares.clear();
  },
  takeshare(observationId) {
    const link = observedShares.get(observationId) || null;
    observedShares.clear();
    shareTarget = null;
    return link;
  },
  allowpath(path) {
    if (typeof path !== 'string' || !/^\/api\/sns\/v\d+\/[a-z0-9_/-]+$/.test(path)) throw new Error('INVALID_OBSERVATION_PATH');
    paths.add(path);
    return Array.from(paths);
  }
};
const secret = /token|cookie|authorization|session|shield|password|credential|secret|signature|^sign$|^sid$|^x-mini-/i;
const limit = 1024 * 1024;
let count = 0;
function emit(value) { if (count++ < 100) send(value); }
Java.perform(() => {
  const Uri = Java.use('android.net.Uri');
  const Builder = Java.use('okhttp3.Response$Builder');
  const seen = new Set();
  function clean(value, key = '') {
    if (secret.test(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map(x => clean(x));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, clean(v,k)]));
    if (typeof value === 'string') {
      // Mini-program paths can contain another URL encoded several times.
      // Normalize those strings before removing nested credential parameters.
      for (let i=0; i<4; i++) {
        const decoded = String(Uri.decode(value));
        if (decoded === value) break;
        value = decoded;
      }
      if (/^\s*[\[{]/.test(value)) {
        try { return JSON.stringify(clean(JSON.parse(value))); } catch (_) {}
      }
      return value.replace(/([?&]|^)([a-z0-9_.-]*(?:token|cookie|authorization|session|shield|password|credential|secret|signature)[a-z0-9_.-]*|sign|sid)=([^&#\s]*)/gi, '$1$2=REDACTED');
    }
    return value;
  }
  function requestInfo(req) {
    const url = req.url(), path = String(url.encodedPath());
    if (!paths.has(path)) return null;
    const query = [];
    for (let i=0; i<url.querySize(); i++) {
      const name = String(url.queryParameterName(i)), value = url.queryParameterValue(i);
      query.push({name, value: value === null ? null : clean(String(value), name)});
    }
    return {method:String(req.method()), host:String(url.host()), path, query,
      header_names:Array.from(req.headers().names().toArray()).map(String)};
  }
  function transportInfo(res) {
    const info = {network_response_present:null, cache_response_present:null,
      sent_at_ms:null, received_at_ms:null, protocol:null, tls:null};
    try {
      info.network_response_present = res.networkResponse() !== null;
      info.cache_response_present = res.cacheResponse() !== null;
      info.sent_at_ms = Number(res.sentRequestAtMillis());
      info.received_at_ms = Number(res.receivedResponseAtMillis());
      info.protocol = String(res.protocol());
      const handshake = res.handshake();
      if (handshake !== null) {
        info.tls = {version:String(handshake.tlsVersion()), cipher_suite:String(handshake.cipherSuite()), peer_certificate_sha256:[]};
        const digest = Java.use('java.security.MessageDigest').getInstance('SHA-256');
        const certificates = handshake.peerCertificates();
        for (let i=0; i<Math.min(Number(certificates.size()),8); i++) {
          const cert = Java.cast(certificates.get(i),Java.use('java.security.cert.Certificate'));
          const bytes = digest.digest(cert.getEncoded());
          info.tls.peer_certificate_sha256.push(Array.from(bytes).map(b => (b & 255).toString(16).padStart(2,'0')).join(''));
        }
      }
    } catch (_) { info.metadata_incomplete = true; }
    return info;
  }
  // Version-pinned REA: CronetUrlRequest.onResponseStarted -> r -> m0.
  // Capture the native response callback without changing its arguments/result.
  try {
    const Cronet = Java.use('org.chromium.net.impl.CronetUrlRequest');
    const urlFields = Array.from(Cronet.class.getDeclaredFields()).filter(f => String(f.getType().getName()) === 'java.util.List');
    if (urlFields.length !== 1) throw new Error('CRONET_URL_CHAIN_AMBIGUOUS');
    urlFields[0].setAccessible(true);
    const callback = Cronet.onResponseStarted.overload('int','java.lang.String','[Ljava.lang.String;','boolean','java.lang.String','java.lang.String','long');
    callback.implementation = function(status,statusText,headers,wasCached,protocol,proxy,byteCount) {
      try {
        const chain = Java.cast(urlFields[0].get(this),Java.use('java.util.List'));
        if (chain.size() > 0) {
          const uri = Uri.parse(String(chain.get(chain.size()-1)));
          const path = String(uri.getEncodedPath());
          if (paths.has(path)) {
            const query=[];
            for (const name of Array.from(uri.getQueryParameterNames().toArray()).map(String)) {
              const values=uri.getQueryParameters(name);
              for(let i=0;i<values.size();i++) query.push({name,value:clean(String(values.get(i)),name)});
            }
            emit({event:'cronet_response_started',at:Date.now(),
              request:{host:String(uri.getHost()),path,query},status:Number(status),
              was_cached:Boolean(wasCached),protocol:String(protocol),received_byte_count:Number(byteCount),
              basis:'REA verified CronetUrlRequest.onResponseStarted native callback; URL chain and cache flag'});
          }
        }
      } catch (_) { emit({event:'cronet_observer_error',reason:'callback metadata unavailable'}); }
      return callback.call(this,status,statusText,headers,wasCached,protocol,proxy,byteCount);
    };
    emit({event:'cronet_observer_ready',at:Date.now()});
  } catch (_) { emit({event:'cronet_observer_unavailable',at:Date.now()}); }
  const build = Builder.build.overload();
  build.implementation = function () {
    const res = build.call(this);
    try {
      const request = requestInfo(res.request());
      if (request) {
        const stamp = String(res.receivedResponseAtMillis()) + ':' + JSON.stringify(request);
        // Multiple builder calls can describe the same response. Observe only
        // the decoded response; compressed wire bytes are not JSON evidence.
        if (res.body() !== null && res.header('Content-Encoding') === null && !seen.has(stamp) && seen.size < 20) {
          seen.add(stamp);
          const copy = res.peekBody(limit), text = String(copy.string());
          try {
            const body = JSON.parse(text), observationId = String(seen.size);
            // Only the requested note's observed URL crosses the private RPC.
            // Events and all capture files continue to receive clean(body).
            retainObservedShare(body, request, observationId);
            emit({event:'response_json', at:Date.now(), request, status:res.code(),
              observation_id:observationId,
              received_at_ms:String(res.receivedResponseAtMillis()), body:clean(body),
              transport:transportInfo(res),
              body_bytes:Number(copy.contentLength()), at_peek_limit:Number(copy.contentLength()) >= limit});
          } catch (_) { emit({event:'body_unavailable', request, status:res.code(), reason:'not complete JSON', utf16_units:text.length}); }
        }
      }
    } catch(e) { emit({event:'observer_error', reason:String(e)}); }
    return res;
  };
  send({event:'observer_ready', at:Date.now(), paths:Array.from(paths), limits:{events:100,peek_bytes:limit},
    basis:'xhs/observe-content-http.js; selected OkHttp Response.Builder.build observation',
    limitations:['attach window only','peekBody may prefetch bytes','builder events are not independent network request counts','header values excluded','missing OkHttp network/cache metadata is unknown, including alternate transports']});
});
