/** Interfaz de WhatsApp vinculado por QR. Se inserta en el script y CSS del panel. */
export const QR_PANEL_JS = String.raw`
var qrwModal=null,qrwList=null,qrwHistTimer=null;
function qrwWs(){
 try{if(typeof attWs==='function')return new URLSearchParams(attWs()).get('ws')||'default';}catch(_){}
 return typeof wsIdForUrl==='function'?(wsIdForUrl()||'default'):'default';
}
function qrwEsc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function qrwState(s){return {connecting:'Preparando conexión',qr:'Escanea el QR',connected:'Conectado',reconnecting:'Reconectando',disconnected:'Desconectado',error:'Necesita revisión'}[s]||'Estado no disponible';}
// El mismo logo verde que pinta una tarjeta de Meta sin foto de perfil.
function qrwLogo(){return typeof netIcoColor==='function'?netIcoColor('whatsapp','25D366'):ICN('phone');}
// «+» delante, como los de Meta. Sin separadores: dependen del país y aquí no lo sabemos.
function qrwTel(p){var d=String(p||'').replace(/\D/g,'');return d?('+'+d):'Sin vincular todavía';}
function qrwCuenta(rows){
 var card=document.querySelector('.cn-card-wa'),sub=card&&card.querySelector('.cn-sub');if(!sub)return;
 var n=rows.length,meta=(window.__cnWa||[]).length, total=meta+n;
 qrwEst(card,rows,meta);
 if(!n){if(sub.dataset.qrwBase)sub.textContent=sub.dataset.qrwBase;return;}
 if(!sub.dataset.qrwBase)sub.dataset.qrwBase=sub.textContent;
 sub.textContent=total+' número'+(total===1?'':'s')+' conectado'+(total===1?'':'s')
  +' · '+meta+' por Meta y '+n+' por QR';
}
// CON-02-FIN · la tarjeta de WhatsApp nace con el estado de los números de Meta. Con números
// solo por QR nacía «Sin conectar · Conectar» mientras debajo decía «N números conectados»:
// el estado de la sesión QR (conectada o no, lo dice el propio servicio) entra aquí.
// Un número QR caído pide atención aunque los de Meta vayan bien; sin QR se vuelve al de Meta.
function qrwEst(card,rows,meta){
 if(typeof cnSetEst!=='function')return;
 var d=card.dataset;
 if(!('qrwEst' in d))d.qrwEst=(card.getAttribute('data-est')||'')+'|'+(card.getAttribute('data-chk')||'');
 var on=rows.filter(function(r){return r.status==='connected';}).length;
 var caidos=rows.filter(function(r){return r.status!=='connected'&&['connecting','qr','reconnecting'].indexOf(r.status)<0;}).length;
 var base=d.qrwEst.split('|'),est,chk='';
 if(!rows.length){est=base[0];chk=base[1];delete d.qrwEst;}
 else if(caidos){est='aten';chk=rows.length===1?'El móvil se ha desvinculado · pulsa Reconectar':'Algún número se ha desvinculado del móvil · pulsa Reconectar';}
 else if(meta)return;
 else if(on){est='ok';}
 else{est='load';}
 if(!est)return;
 cnSetEst(card,est,chk,est==='ok'?Date.now():0,'');
 if(typeof cnEstPaint==='function')cnEstPaint(card);
 if(typeof cnCmp==='function')cnCmp(card);
}
function qrwHist(s){
 var p=s.historyProgress;
 if(typeof p!=='number'||!(p<100))return '';
 var v=Math.max(0,Math.min(100,Math.round(p)));
 return '<div class=qrw-hist role=status><div class=qrw-hist-bar><i style="width:'+v+'%"></i></div><span>Trayendo tus conversaciones de los \u00faltimos 90 d\u00edas\u2026 '+v+' %</span></div>';
}
async function qrwFetch(path,ws,controller,method,body){
 var timer=setTimeout(function(){controller.abort();},20000);
 try{
  var headers={'Accept':'application/json','X-Workspace-Id':ws};
  if(body)headers['Content-Type']='application/json';
  var response=await fetch('/admin/api/connections/wa/qr'+path+(ws==='default'?'':'?ws='+encodeURIComponent(ws)),{method:method||'GET',headers:headers,credentials:'same-origin',cache:'no-store',signal:controller.signal,body:body?JSON.stringify(body):undefined});
  var data;try{data=await response.json();}catch(_){throw new Error('El servicio no respondió correctamente. Vuelve a intentarlo.');}
  if(!response.ok)throw new Error(typeof data.error==='string'?data.error:'No se pudo completar la conexión. Vuelve a intentarlo.');
  return data;
 }finally{clearTimeout(timer);}
}
async function waQrLoad(force){
 var box=document.getElementById('cn_wa_qr');if(!box)return;
 var ws=qrwWs();
 if(!force&&qrwList&&qrwList.box===box&&qrwList.ws===ws&&qrwList.pending)return qrwList.pending;
 clearTimeout(qrwHistTimer);qrwHistTimer=null;
 if(qrwList)qrwList.controller.abort();
 var ctx={box:box,ws:ws,controller:new AbortController(),pending:null};qrwList=ctx;
 box.innerHTML='<p class=muted role=status>Cargando conexiones…</p>';
 ctx.pending=(async function(){
  try{
   var data=await qrwFetch('',ws,ctx.controller);
   if(qrwList!==ctx||!box.isConnected||qrwWs()!==ws)return;
   if(!data||!Array.isArray(data.sessions))throw new Error('No se pudieron leer las conexiones. Vuelve a intentarlo.');
   var rows=data.sessions.map(function(s){return {id:s.id,label:s.label,phone:s.phone,status:s.status,error:s.error,historyProgress:s.historyProgress};}).sort(function(a,b){return String(a.label||a.phone||'').localeCompare(String(b.label||b.phone||''),'es');});
   if(!rows.length){box.innerHTML='';qrwCuenta([]);return;}
   box.innerHTML=(rows.map(function(s){
     var id=qrwEsc(s.id),on=s.status==='connected',busy=['connecting','qr','reconnecting'].indexOf(s.status)>=0;
     return '<div class=cn-wa-num><span class="cn-wa-ic cn-wa-ic-img">'+qrwLogo()+'</span><div class=cn-wa-meta>'
      +'<b>'+qrwEsc(s.label||'WhatsApp')+'<span class="cn-bdg main">Por QR</span>'+(on?'':'<span class="cn-bdg aviso">'+qrwEsc(qrwState(s.status))+'</span>')+'</b>'
      +'<span class="cn-wa-sub'+(s.phone?'':' qrw-sub-txt')+'">'+qrwEsc(qrwTel(s.phone))+'</span>'
      +qrwHist(s)+(s.error?'<p class=qrw-row-error>'+qrwEsc(String(s.error).slice(0,240))+'</p>':'')
      +'</div><div class=cn-wa-acts>'
      +(!on?'<button type=button class=cn-wa-mk data-qrw-action=open data-qrw-id="'+id+'" title="Vuelve a mostrar el código para vincularlo con el móvil">'+ICN('bolt')+(busy?'Ver conexión':'Reconectar')+'</button>':'')
      +'<button type=button class=icbtn data-qrw-action=disconnect data-qrw-id="'+id+'" data-qrw-label="'+qrwEsc(s.label||s.phone||'este número')+'" title="Quitar esta conexión">'+ICN('trash')+'</button>'
      +'</div></div>';
    }).join(''));
   qrwCuenta(rows);
   if(rows.some(function(r){return typeof r.historyProgress==='number'&&r.historyProgress<100;}))qrwHistTimer=setTimeout(function(){waQrLoad(true);},4000);
  }catch(error){
   if(qrwList!==ctx||!box.isConnected||qrwWs()!==ws)return;
   box.innerHTML='<div class=qrw-inline-error role=alert><p>'+qrwEsc(error.name==='AbortError'?'La conexión tardó demasiado. Vuelve a intentarlo.':error.message)+'</p><button type=button class="sec qrw-action" data-qrw-action=reload>Reintentar</button></div>';
  }finally{ctx.pending=null;}
 })();
 box.onclick=function(event){var b=event.target.closest('[data-qrw-action]');if(!b||!box.contains(b))return;var action=b.dataset.qrwAction;if(action==='new')waQrOpen();else if(action==='open')waQrOpen(b.dataset.qrwId);else if(action==='reload')waQrLoad();else if(action==='disconnect')qrwDisconnect(b);};
 return ctx.pending;
}
async function qrwDisconnect(button){
 if(button.disabled)return;button.disabled=true;var ws=qrwWs(),id=button.dataset.qrwId;
 try{
  var yes=await confirmAct({title:'¿Quitar esta conexión?',body:'El panel dejará de recibir y enviar mensajes con '+button.dataset.qrwLabel+'. Las conversaciones y los contactos NO se borran. Podrás vincularlo de nuevo con un QR.',ok:'Quitar',cancel:'Cancelar'});
  if(!yes||qrwWs()!==ws||!button.isConnected)return;
  await qrwFetch('/'+encodeURIComponent(id),ws,new AbortController(),'DELETE');
  if(qrwWs()!==ws)return;
  await waQrLoad(true);if(typeof toast==='function')toast('Conexión quitada','ok');
 }catch(error){
  if(qrwWs()!==ws||!button.isConnected)return;
  var row=button.closest('.cn-wa-num');var old=row.querySelector('.qrw-inline-error');if(old)old.remove();
  var note=document.createElement('p');note.className='qrw-inline-error';note.setAttribute('role','alert');note.textContent=error.name==='AbortError'?'La desconexión tardó demasiado. Vuelve a intentarlo.':error.message;row.appendChild(note);
 }finally{if(button.isConnected)button.disabled=false;}
}
function qrwAlive(ctx){return qrwModal===ctx&&!ctx.closed&&ctx.el.isConnected&&qrwWs()===ctx.ws;}
function qrwClearImage(ctx){var image=ctx.el.querySelector('.qrw-code img');if(image)image.removeAttribute('src');}
function qrwStop(ctx){clearTimeout(ctx.timer);clearTimeout(ctx.expiry);ctx.timer=null;ctx.expiry=null;if(ctx.controller){ctx.controller.abort();ctx.controller=null;}}
function qrwClose(ctx){
 if(!ctx||ctx.closed)return;ctx.closed=true;qrwStop(ctx);clearInterval(ctx.watch);ctx.observer.disconnect();qrwClearImage(ctx);ctx.el.remove();
 window.removeEventListener('pagehide',ctx.onHide);document.removeEventListener('keydown',ctx.onKey,true);if(qrwModal===ctx)qrwModal=null;
 if(ctx.didStart&&qrwWs()===ctx.ws)waQrLoad(true);
 if(qrwWs()===ctx.ws&&ctx.returnFocus&&ctx.returnFocus.isConnected)ctx.returnFocus.focus();
}
function waQrOpen(id){
 if(typeof viewAllowed==='function'&&!viewAllowed('connections'))return;
 if(qrwModal)qrwClose(qrwModal);
 var el=document.createElement('div');el.className='ovl qrw-overlay';el.id='qrw_modal';
 el.innerHTML='<div class="ovlbox qrw-modal" role=dialog aria-modal=true aria-labelledby=qrw_title><div class=ovlh><b id=qrw_title>'+ICN('phone')+' Conectar WhatsApp por QR</b><button type=button class=qrw-close data-qrw-action=close aria-label="Cerrar conexión por QR">'+ICN('x')+'</button></div><div class=qrw-modal-body>'
  +'<form class=qrw-form><div class=qrw-field><label class=fl for=qrw_label>Nombre de esta conexión</label><input id=qrw_label name=label maxlength=80 autocomplete=off placeholder="Por ejemplo: Atención al cliente" required><p>Para reconocer este número en el panel.</p></div><div class=qrw-progress hidden aria-live=polite></div><p class=qrw-modal-error role=alert hidden></p><div class=qrw-footer><button type=button class="sec qrw-action" data-qrw-action=close>Cancelar</button><button type=submit class="primary qrw-action qrw-submit">Generar QR</button></div></form></div></div>';
 var ctx={el:el,ws:qrwWs(),id:id?String(id):'',closed:false,busy:false,timer:null,watch:null,controller:null,observer:null,returnFocus:document.activeElement,connected:false};
 qrwModal=ctx;document.body.appendChild(el);
 ctx.observer=new MutationObserver(function(){if(!qrwAlive(ctx))qrwClose(ctx);});ctx.observer.observe(document.body,{childList:true,subtree:true});
 ctx.watch=setInterval(function(){if(!qrwAlive(ctx))qrwClose(ctx);},400);
 ctx.onHide=function(){qrwClose(ctx);};window.addEventListener('pagehide',ctx.onHide);
 el.onclick=function(event){if(event.target===el){qrwClose(ctx);return;}var b=event.target.closest('[data-qrw-action]');if(!b||!el.contains(b))return;if(b.dataset.qrwAction==='close')qrwClose(ctx);if(b.dataset.qrwAction==='retry')qrwPoll(ctx);if(b.dataset.qrwAction==='recover')qrwRecover(ctx);if(b.dataset.qrwAction==='resume'){ctx.id=b.dataset.qrwId;ctx.needsRecovery=false;qrwPoll(ctx);}};
 ctx.onKey=function(event){
  if(!qrwAlive(ctx))return;var overlays=Array.from(document.querySelectorAll('.ovl')).filter(function(o){return !!o.getClientRects().length;});if(overlays[overlays.length-1]!==el)return;
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();qrwClose(ctx);return;}
  if(event.key!=='Tab')return;var items=Array.from(el.querySelectorAll('button:not([disabled]),input:not([disabled])')).filter(function(x){return !!x.getClientRects().length;});
  if(!items.length)return;var first=items[0],last=items[items.length-1];if(!el.contains(document.activeElement)){event.preventDefault();event.stopImmediatePropagation();(event.shiftKey?last:first).focus();}else if(event.shiftKey&&document.activeElement===first){event.preventDefault();event.stopImmediatePropagation();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();event.stopImmediatePropagation();first.focus();}
 };document.addEventListener('keydown',ctx.onKey,true);
 el.querySelector('form').onsubmit=function(event){event.preventDefault();qrwStart(ctx);};
 el.querySelector('#qrw_label').focus();
 if(ctx.id)qrwPoll(ctx,true);
}
function qrwBusy(ctx,busy){ctx.busy=busy;var submit=ctx.el.querySelector('.qrw-submit');submit.disabled=busy;ctx.el.querySelector('#qrw_label').disabled=busy;}
function qrwError(ctx,error,retry){
 if(!qrwAlive(ctx))return;ctx.paused=true;qrwStop(ctx);qrwClearImage(ctx);qrwBusy(ctx,false);
 var err=ctx.el.querySelector('.qrw-modal-error');err.hidden=false;err.textContent=error;
 var area=ctx.el.querySelector('.qrw-progress');area.hidden=false;area.innerHTML=retry?'<button type=button class="sec qrw-action" data-qrw-action=retry>Reintentar estado</button>':'';
 var submit=ctx.el.querySelector('.qrw-submit');submit.hidden=!!retry;submit.textContent=ctx.id?'Volver a conectar':'Generar QR';
}
async function qrwStart(ctx){
 if(!qrwAlive(ctx)||ctx.busy||ctx.needsRecovery)return;var label=ctx.el.querySelector('#qrw_label').value.trim();if(!label){ctx.el.querySelector('#qrw_label').focus();return;}
 ctx.startLabel=label;ctx.didStart=true;
 ctx.paused=false;qrwStop(ctx);qrwBusy(ctx,true);ctx.el.querySelector('.qrw-modal-error').hidden=true;ctx.el.querySelector('.qrw-submit').textContent='Preparando…';
 var area=ctx.el.querySelector('.qrw-progress');area.hidden=false;area.innerHTML='<p class=qrw-wait role=status>Preparando el código para vincular tu móvil…</p>';
 ctx.controller=new AbortController();
 try{
  var data=await qrwFetch('/start',ctx.ws,ctx.controller,'POST',Object.assign({label:label},ctx.id?{id:ctx.id}:{}));
  if(!qrwAlive(ctx))return;if(!data||!data.id)throw new Error('No se pudo iniciar la conexión. Vuelve a intentarlo.');
  ctx.id=String(data.id);ctx.controller=null;qrwBusy(ctx,false);ctx.el.querySelector('.qrw-submit').hidden=true;qrwPaint(ctx,data);if(!ctx.connected&&!ctx.paused)qrwPoll(ctx);
 }catch(error){if(qrwAlive(ctx)){qrwError(ctx,error.name==='AbortError'?'La conexión tardó demasiado. Comprobemos si se ha creado antes de repetirla.':error.message,false);if(!ctx.id){ctx.needsRecovery=true;ctx.el.querySelector('.qrw-submit').hidden=true;qrwRecover(ctx);}}}
}
async function qrwRecover(ctx){
 if(!qrwAlive(ctx)||ctx.busy)return;qrwStop(ctx);qrwBusy(ctx,true);ctx.controller=new AbortController();
 var area=ctx.el.querySelector('.qrw-progress');area.hidden=false;area.innerHTML='<p class=qrw-wait role=status>Comprobando si la conexión ya está creada…</p>';
 try{
  var data=await qrwFetch('',ctx.ws,ctx.controller);if(!qrwAlive(ctx))return;
  if(!data||!Array.isArray(data.sessions))throw new Error('No se pudo comprobar la conexión.');
  ctx.controller=null;qrwBusy(ctx,false);
  var found=data.sessions.filter(function(s){return s.label===ctx.startLabel&&s.status!=='disconnected';});
  if(found.length===1){ctx.id=String(found[0].id);ctx.needsRecovery=false;qrwPoll(ctx);return;}
  if(found.length){area.innerHTML='<div class=qrw-recover><p>Hay conexiones con ese nombre. Elige la que quieres continuar.</p>'+found.map(function(s){return '<button type=button class="sec qrw-action" data-qrw-action=resume data-qrw-id="'+qrwEsc(s.id)+'">'+qrwEsc(s.phone||s.label)+' · '+qrwState(s.status)+'</button>';}).join('')+'</div>';return;}
  ctx.needsRecovery=false;area.innerHTML='<p class=qrw-wait>No aparece ninguna conexión con ese nombre. Puedes volver a intentarlo.</p>';ctx.el.querySelector('.qrw-submit').hidden=false;
 }catch(error){if(qrwAlive(ctx)){qrwBusy(ctx,false);area.innerHTML='<div class=qrw-recover><p>No se pudo comprobar si el vínculo se ha creado. Compruébalo antes de volver a generar otro.</p><button type=button class="sec qrw-action" data-qrw-action=recover>Comprobar conexión</button></div>';}}
}
function qrwPaint(ctx,data){
 clearTimeout(ctx.expiry);ctx.expiry=null;
 var state=String(data.status||'connecting'),area=ctx.el.querySelector('.qrw-progress');area.hidden=false;
 ctx.el.querySelector('.qrw-modal-error').hidden=true;
 if(data.label)ctx.el.querySelector('#qrw_label').value=String(data.label);
 var submit=ctx.el.querySelector('.qrw-submit');
 if(state==='connected'){
  qrwStop(ctx);qrwClearImage(ctx);submit.hidden=true;ctx.el.querySelector('#qrw_label').disabled=true;
  area.innerHTML='<div class=qrw-success>'+ICN('check')+'<b>WhatsApp conectado</b><span>'+qrwEsc(data.phone||data.label||'Tu número ya está vinculado.')+'</span><button type=button class="primary qrw-action" data-qrw-action=close>Listo</button></div>';
  var cancel=ctx.el.querySelector('.qrw-footer [data-qrw-action=close]');cancel.hidden=true;
  if(!ctx.connected){ctx.connected=true;waQrLoad(true);if(typeof trasConectarOk==='function')trasConectarOk();}
  return;
 }
 if(state==='error'||state==='disconnected'){
  qrwError(ctx,typeof data.error==='string'?data.error:'La conexión se ha cerrado. Genera un QR nuevo para volver a vincularla.',false);return;
 }
 if(['connecting','qr','reconnecting'].indexOf(state)<0){qrwError(ctx,'No se pudo reconocer el estado de la conexión. Vuelve a consultarlo.',true);return;}
 submit.hidden=true;ctx.el.querySelector('#qrw_label').disabled=true;
 var expires=typeof data.expiresAt==='number'?data.expiresAt:Date.parse(data.expiresAt||'');
 var fresh=!Number.isFinite(expires)||expires>Date.now();
 var qr=typeof data.qrDataUrl==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qrDataUrl)&&data.qrDataUrl.length<1000000?data.qrDataUrl:'';
 if(state==='qr'&&data.qrDataUrl&&!qr){qrwError(ctx,'No se pudo mostrar el código QR. Vuelve a consultarlo.',true);return;}
 if(state==='qr'&&qr&&fresh){
  var img=area.querySelector('.qrw-code img');
  if(!img){area.innerHTML='<div class=qrw-scan><div class=qrw-code><img alt="Código QR para vincular tu WhatsApp" width=240 height=240></div><div class=qrw-instructions><b>Escanéalo desde WhatsApp</b><ol><li>Abre WhatsApp o WhatsApp Business en tu móvil.</li><li>Entra en <b>Dispositivos vinculados</b>.</li><li>Pulsa <b>Vincular dispositivo</b> y apunta al código.</li></ol><span class=qrw-live>Esperando a que vincules el dispositivo…</span></div></div>';img=area.querySelector('.qrw-code img');}
  if(img.getAttribute('src')!==qr)img.src=qr;
  if(Number.isFinite(expires))ctx.expiry=setTimeout(function(){if(!qrwAlive(ctx))return;qrwClearImage(ctx);area.innerHTML='<p class=qrw-wait role=status>El código ha caducado. Esperando uno nuevo…</p>';qrwPoll(ctx);},Math.max(1,Math.min(expires-Date.now(),2147483647)));
 }else{qrwClearImage(ctx);area.innerHTML='<div class=qrw-wait role=status>'+ICN('phone')+'<b>'+qrwState(state)+'</b><span>'+(state==='qr'?'Actualizando el código. Espera un momento…':'Mantén WhatsApp abierto en tu móvil. El código aparecerá aquí.')+'</span></div>';}
}
async function qrwPoll(ctx,first){
 if(!qrwAlive(ctx)||ctx.busy||!ctx.id||ctx.connected)return;
 ctx.paused=false;clearTimeout(ctx.timer);ctx.timer=null;qrwBusy(ctx,true);ctx.controller=new AbortController();
 try{
  var data=await qrwFetch('/'+encodeURIComponent(ctx.id),ctx.ws,ctx.controller);
  if(!qrwAlive(ctx))return;if(!data||!data.id)throw new Error('No se pudo leer el estado de esta conexión.');
  ctx.controller=null;qrwBusy(ctx,false);qrwPaint(ctx,data);
  if(!ctx.connected&&!ctx.paused&&['connecting','qr','reconnecting'].indexOf(data.status)>=0)ctx.timer=setTimeout(function(){qrwPoll(ctx);},2000);
 }catch(error){if(qrwAlive(ctx))qrwError(ctx,error.name==='AbortError'?'El estado tardó demasiado. Vuelve a intentarlo.':error.message,!first);}
}
`;

export const QR_PANEL_CSS = String.raw`
/* LISTA-UNICA-1 · las filas viven DENTRO de .cn-wa-list, con los numeros de Meta:
   ni borde, ni margen, ni encabezado propio — es la misma lista. */
#cn_wa_qr{display:contents}
.qrw-modal [hidden]{display:none!important}
/* Esa linea es monoespaciada porque suele llevar un telefono; cuando lleva una frase, no. */
.cn-wa-num .qrw-sub-txt{font-family:inherit}
.qrw-row-error{color:var(--dang);font-size:12px;line-height:1.5;margin:3px 0 0;overflow-wrap:anywhere;flex-basis:100%}
.qrw-hist{display:flex;flex-direction:column;gap:5px;margin-top:4px;max-width:340px}
.qrw-hist-bar{height:5px;border-radius:999px;background:var(--panel2);overflow:hidden}
.qrw-hist-bar>i{display:block;height:100%;border-radius:999px;background:var(--acc)}
.qrw-hist>span{font-size:11px;color:var(--dim)}
.qrw-action{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;white-space:normal;max-width:100%}
.qrw-overlay{z-index:1300}
/* DISENO-1 · .qrw-modal{width} perdía ante .ovlbox{width:min(860px,96vw)} (misma especificidad,
   declarada después): el modal medía 860 px para un campo y dos botones, frente a los 560 del
   asistente hermano «Conectar mediante Meta». Con .ovlbox.qrw-modal (0,2,0) gana y mide lo mismo. */
.ovlbox.qrw-modal{width:min(560px,96vw);max-height:92dvh;display:flex;flex-direction:column}
.qrw-modal .ovlh{flex:none}
.qrw-modal .ovlh>b{display:flex;gap:9px;align-items:center;min-width:0;font-size:15px}
/* DISENO-1 · el cierre era un botón cuadrado con borde; el resto de modales usan la «x» plana
   de .ovlh .x. Sigue siendo <button> (foco y Tab del modal) pero con ese mismo aspecto. */
.qrw-close{width:30px;height:30px;min-width:30px;min-height:0;padding:0;border:0;border-radius:9px;background:transparent;box-shadow:none;text-shadow:none;color:var(--dim);display:flex;align-items:center;justify-content:center;transition:background .12s,color .12s}
.qrw-close svg{width:16px;height:16px}
.qrw-modal-body{overflow:auto;padding:20px;min-height:0}
.qrw-form{margin:0;display:grid;gap:16px}
.qrw-field{padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.qrw-field input{width:100%;margin:0}
.qrw-field p{font-size:12px;color:var(--dim);margin:8px 0 0}
.qrw-footer{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.qrw-recover{display:flex;flex-direction:column;align-items:flex-start;gap:10px;font-size:12px;line-height:1.6;color:var(--dim)}
.qrw-recover p{margin:0}
.qrw-progress{border:1px solid var(--line);border-radius:12px;padding:18px;background:var(--panel)}
/* DISENO-1 · el bloque va SIEMPRE en columna. En fila las instrucciones no cabían en ningún
   ancho: el modal mide como mucho 560 y el código ocupa 264 fijos, así que a la columna de
   texto le quedaban 194 px y partía «Dispositivos vinculados» y cada paso en dos líneas
   (regla 3: nunca encoger un componente por debajo de su ancho natural). */
.qrw-scan{display:flex;flex-direction:column;align-items:center;gap:16px}
.qrw-code{padding:12px;background:#fff;border-radius:12px;flex:none;width:264px;height:264px}
.qrw-code img{display:block;width:240px;height:240px;max-width:none}
.qrw-instructions{min-width:0;width:100%;font-size:13px;line-height:1.6;color:var(--dim)}
.qrw-instructions>b{color:var(--tx);font-size:14px}
.qrw-instructions ol{padding-left:18px;margin:12px 0}
.qrw-instructions li{margin:8px 0}
.qrw-live{font-size:12px;display:block}
.qrw-wait,.qrw-success{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:20px 4px;text-align:center;color:var(--dim);font-size:13px;line-height:1.6;margin:0}
.qrw-wait>b,.qrw-success>b{color:var(--tx);font-size:16px}
.qrw-wait>svg,.qrw-success>svg{width:30px;height:30px;color:var(--acc)}
.qrw-success>svg{color:var(--good)}
.qrw-success>span{overflow-wrap:anywhere;max-width:100%}
.qrw-inline-error,.qrw-modal-error{color:var(--dang);font-size:12px;line-height:1.6;margin:0;overflow-wrap:anywhere;flex-basis:100%}
.qrw-inline-error p{margin:0 0 10px}
.qrw-action[class]:hover{transform:none;filter:none;box-shadow:none;background:var(--panel2);border-color:var(--line2)}
.qrw-close[class]:hover{transform:none;filter:none;box-shadow:none;background:var(--panel3);color:var(--tx)}
.qrw-action[class]::after,.qrw-close[class]::after{display:none}
@media(max-width:620px){.qrw-modal-body{padding:16px}.qrw-progress{padding:14px}}
@media(max-width:360px){.qrw-modal-body{padding:12px}.qrw-progress{padding:8px}.qrw-code{transform:scale(.9);margin:-13px}}
`;
