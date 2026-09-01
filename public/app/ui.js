/* ─────────────────────────────────────────────────────────────
   ui.js — shared UI primitives. Load before the page script.

   Modal.open({tag, body, save, del, onOpen})   centred vignette
   Modal.close()                                pops the top one
   calField(key, label, value)                  date picker markup
   calValue(key)                                its current value

   Every screen (habits, tasks, project, task detail) calls the same
   shell and supplies only its own fields. Styles inject on load.
   ───────────────────────────────────────────────────────────── */

(function injectUiCss(){
  var css=[
  /* height and top are driven by fitModals() so the sheet tracks the visual
     viewport and stays above an open keyboard rather than behind it */
  '.modal{display:flex;position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.72);align-items:center;justify-content:center;padding:18px}',
  '.sheet{width:100%;max-width:420px;max-height:100%;overflow-y:auto;scrollbar-width:none;background:#000;border:1.5px solid #fff;border-radius:14px;padding:16px 16px 14px;animation:uipop .16s ease}',
  '.sheet::-webkit-scrollbar{display:none}',
  '@keyframes uipop{from{opacity:0;transform:scale(0.96)}to{opacity:1;transform:scale(1)}}',
  '.ov-tag{font-size:9px;color:#fff;letter-spacing:0.08em;margin-bottom:10px}',
  '.ov-inp{width:100%;font-family:inherit;font-size:11px;color:#fff;background:#000;border:1.5px solid #fff;border-radius:10px;padding:10px 12px;height:40px;outline:none;margin-bottom:8px}',
  '.ov-inp::placeholder{color:#666}',
  '.ov-lbl{font-size:9px;color:#fff;margin-bottom:6px;letter-spacing:0.06em}',
  /* Delete sits hard left, Cancel and Save stay under the thumb. */
  '.ov-acts{display:flex;align-items:center;gap:12px;margin-top:14px}',
  '.ov-spacer{flex:1}',
  '.ov-cancel{font-size:10px;color:#fff;cursor:pointer}',
  '.ov-send{font-size:10px;color:#000;background:#fff;border:none;border-radius:8px;padding:7px 16px;cursor:pointer;font-family:inherit}',
  '.ov-del{font-size:10px;color:#fff;background:#000;border:1px solid #fff;border-radius:8px;padding:6px 12px;cursor:pointer;font-family:inherit}',
  /* date field + calendar */
  '.datefield{width:100%;font-size:11px;color:#fff;background:#000;border:1.5px solid #fff;border-radius:10px;padding:11px 12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}',
  '.datefield .dv{letter-spacing:0.04em}',
  '.datefield .dv.none{color:#666}',
  '.datefield .dset{font-size:9px;letter-spacing:0.08em;color:#fff}',
  '.cal{display:none;border:1.5px solid #fff;border-radius:10px;padding:10px;margin-bottom:8px}',
  '.cal.open{display:block}',
  '.cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}',
  '.cal-mo{font-size:10px;letter-spacing:0.08em;color:#fff}',
  '.cal-nav{width:24px;height:24px;border-radius:7px;border:1px solid #fff;display:flex;align-items:center;justify-content:center;cursor:pointer}',
  '.cal-nav svg{width:8px;height:8px;fill:none;stroke:#fff;stroke-width:2.5}',
  '.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}',
  '.cal-dow{font-size:8px;color:#fff;text-align:center;letter-spacing:0.06em;opacity:0.55;padding-bottom:2px}',
  '.cal-d{aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;border-radius:6px;cursor:pointer;border:1px solid transparent}',
  '.cal-d.today{border-color:#fff}',
  '.cal-d.sel{background:#fff;color:#000;border-color:#fff}',
  '.cal-d.pad{visibility:hidden;pointer-events:none}',
  '.cal-foot{display:flex;justify-content:flex-end;margin-top:9px}',
  '.cal-clear{font-size:9px;color:#fff;cursor:pointer;letter-spacing:0.08em}'
  ].join('');
  var s=document.createElement('style');
  s.textContent=css;
  document.head.appendChild(s);
})();

/* ── MODAL SHELL ── stackable: a task vignette can open over a project one */
var Modal=(function(){
  var stack=[];

  /* An open keyboard shrinks the visual viewport but not the layout viewport,
     so a fixed full-height overlay would sit half-covered. Track the visual
     viewport instead: the sheet then spans kerb-to-keyboard and scrolls
     internally when its fields no longer fit. */
  function fitModals(){
    var vv=window.visualViewport;
    stack.forEach(function(el){
      if(vv){el.style.top=vv.offsetTop+'px';el.style.height=vv.height+'px';}
      else  {el.style.top='0px';el.style.height='100%';}
    });
  }
  if(window.visualViewport){
    window.visualViewport.addEventListener('resize',fitModals);
    window.visualViewport.addEventListener('scroll',fitModals);
  }

  function open(o){
    var el=document.createElement('div');
    el.className='modal';
    el.style.zIndex=100+stack.length;
    el.innerHTML='<div class="sheet">'+
      '<div class="ov-tag">'+(o.tag||'')+'</div>'+
      (o.body||'')+
      '<div class="ov-acts">'+
        (o.del?'<button class="ov-del" data-act="del">'+(o.del.label||'Delete')+'</button>':'')+
        '<div class="ov-spacer"></div>'+
        '<span class="ov-cancel" data-act="cancel">Cancel</span>'+
        '<button class="ov-send" data-act="save">'+((o.save&&o.save.label)||'Save')+'</button>'+
      '</div></div>';
    el.addEventListener('click',function(e){
      if(e.target===el){close();return;}
      var a=e.target.closest('[data-act]');
      if(!a)return;
      var act=a.getAttribute('data-act');
      if(act==='cancel')close();
      else if(act==='del'&&o.del)o.del.fn();
      else if(act==='save'&&o.save)o.save.fn();
    });
    // keep a focused field visible once the keyboard has finished animating
    el.addEventListener('focusin',function(ev){
      setTimeout(function(){
        if(ev.target&&ev.target.scrollIntoView)ev.target.scrollIntoView({block:'center'});
      },250);
    });
    document.body.appendChild(el);
    stack.push(el);
    fitModals();
    if(o.onOpen)o.onOpen(el);
    return el;
  }
  function close(){var el=stack.pop();if(el)el.remove();}
  return {open:open,close:close,fit:fitModals};
})();

/* ── CALENDAR FIELD ── */
var UI_MONTHS=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
var UI_MONTHS_FULL=['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
var _cal={};

function calToday(){
  if(typeof TODAY==='string'&&TODAY)return TODAY;   // mockups pin a date
  var d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function calFmt(iso){var p=iso.split('-');return parseInt(p[2],10)+' '+UI_MONTHS[parseInt(p[1],10)-1]+' '+p[0];}
function calField(key,label,value,empty){
  _cal[key]={val:value||'',month:'',empty:empty||'No deadline'};
  return '<div class="ov-lbl">'+label+'</div>'+
    '<div class="datefield" onclick="calToggle(\''+key+'\')">'+
      '<span class="dv'+(value?'':' none')+'" id="cal-dv-'+key+'">'+(value?calFmt(value):_cal[key].empty)+'</span>'+
      '<span class="dset">SET</span></div>'+
    '<div class="cal" id="cal-'+key+'"></div>';
}
function calValue(key){return _cal[key]?_cal[key].val:'';}
function calSet(key,iso){
  _cal[key].val=iso;
  var el=document.getElementById('cal-dv-'+key);
  el.textContent=iso?calFmt(iso):_cal[key].empty;
  el.classList.toggle('none',!iso);
}
function calToggle(key){
  var c=document.getElementById('cal-'+key);
  if(c.classList.contains('open')){c.classList.remove('open');return;}
  _cal[key].month=(_cal[key].val||calToday()).slice(0,7);
  calRender(key);
  c.classList.add('open');
}
function calNav(key,d){
  var p=_cal[key].month.split('-');
  var dt=new Date(parseInt(p[0],10),parseInt(p[1],10)-1+d,1);
  _cal[key].month=dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0');
  calRender(key);
}
function calPick(key,iso){calSet(key,iso);document.getElementById('cal-'+key).classList.remove('open');}
function calClear(key){calSet(key,'');document.getElementById('cal-'+key).classList.remove('open');}
function calRender(key){
  var p=_cal[key].month.split('-'), y=parseInt(p[0],10), m=parseInt(p[1],10)-1;
  var lead=(new Date(y,m,1).getDay()+6)%7;          // Monday-first
  var days=new Date(y,m+1,0).getDate(), today=calToday();
  var prev='<svg viewBox="0 0 12 12"><polyline points="8,2 3,6 8,10"/></svg>';
  var next='<svg viewBox="0 0 12 12"><polyline points="4,2 9,6 4,10"/></svg>';
  var h='<div class="cal-head">'+
    '<div class="cal-nav" onclick="calNav(\''+key+'\',-1)">'+prev+'</div>'+
    '<div class="cal-mo">'+UI_MONTHS_FULL[m]+' '+y+'</div>'+
    '<div class="cal-nav" onclick="calNav(\''+key+'\',1)">'+next+'</div></div><div class="cal-grid">';
  ['M','T','W','T','F','S','S'].forEach(function(d){h+='<div class="cal-dow">'+d+'</div>';});
  for(var i=0;i<lead;i++)h+='<div class="cal-d pad"></div>';
  for(var d=1;d<=days;d++){
    var iso=y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    h+='<div class="cal-d'+(iso===_cal[key].val?' sel':'')+(iso===today?' today':'')+'" onclick="calPick(\''+key+'\',\''+iso+'\')">'+d+'</div>';
  }
  document.getElementById('cal-'+key).innerHTML=h+'</div>'+
    '<div class="cal-foot"><span class="cal-clear" onclick="calClear(\''+key+'\')">CLEAR</span></div>';
}
