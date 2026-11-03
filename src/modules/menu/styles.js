/** Start-screen stylesheet. Scoped to `.fm-root`; injected once. */
export const CSS = /* css */`
.fm-root{
  --fm-ink:#05080b;
  --fm-panel:rgba(11,17,24,.80);
  --fm-panel-2:rgba(8,12,17,.86);
  --fm-line:rgba(255,255,255,.10);
  --fm-line-2:rgba(255,255,255,.19);
  --fm-text:#f1f6fa;
  --fm-muted:#9db0c2;
  --fm-dim:#6d8093;
  --fm-accent:#57c8f7;
  --fm-accent-dim:rgba(87,200,247,.16);
  --fm-ui:'Inter','Segoe UI',system-ui,-apple-system,Roboto,sans-serif;
  --fm-mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;
  position:fixed;inset:0;z-index:400;
  font-family:var(--fm-ui);color:var(--fm-text);
  -webkit-font-smoothing:antialiased;
  opacity:1;transition:opacity .55s ease;
  background:var(--fm-ink);
}
.fm-root[data-hidden="1"]{opacity:0;pointer-events:none}

/* ---------------------------------------------------------------- backdrop */
.fm-bg{position:absolute;inset:0;width:100%;height:100%;display:block;
  opacity:0;transition:opacity 1.1s ease}
.fm-root[data-bg="1"] .fm-bg{opacity:1}
.fm-bg-fallback{position:absolute;inset:0;
  background:linear-gradient(180deg,#1d3350 0%,#3a5670 42%,#7d8f92 74%,#43503f 100%)}
.fm-grade{position:absolute;inset:0;pointer-events:none;
  background:
    linear-gradient(100deg,rgba(4,7,10,.90) 0%,rgba(4,7,10,.66) 26%,rgba(4,7,10,.14) 52%,rgba(4,7,10,0) 68%),
    linear-gradient(to top,rgba(4,7,10,.82) 0%,rgba(4,7,10,.10) 30%,rgba(4,7,10,0) 55%),
    radial-gradient(130% 100% at 62% 22%,rgba(4,7,10,0) 34%,rgba(4,7,10,.62) 100%)}

/* ------------------------------------------------------------------- stage */
.fm-stage{position:relative;height:100%;box-sizing:border-box;display:grid;
  grid-template-columns:minmax(0,1fr) 452px;gap:clamp(28px,4vw,64px);align-items:center;
  padding:clamp(26px,4.2vh,54px) clamp(26px,4.6vw,78px)}
.fm-left{min-width:0;max-width:600px;display:flex;flex-direction:column;gap:26px}

/* ------------------------------------------------------------------- brand */
.fm-kicker{display:flex;align-items:center;gap:10px;font:600 11px/1 var(--fm-mono);
  letter-spacing:.22em;text-transform:uppercase;color:var(--fm-accent);margin-bottom:18px}
.fm-kicker i{display:block;width:26px;height:2px;background:var(--fm-accent);border-radius:2px}
.fm-title{margin:0;font-weight:700;line-height:.88;letter-spacing:-.035em;
  font-size:clamp(48px,6.4vw,86px);text-shadow:0 14px 44px rgba(0,0,0,.6)}
.fm-title span{display:block}
.fm-title span:last-child{font-weight:200;color:#cfe0ee}
.fm-tag{margin:20px 0 0;max-width:30ch;font-size:16px;line-height:1.55;color:#c6d5e2;
  text-shadow:0 2px 14px rgba(0,0,0,.55)}

/* -------------------------------------------------------------- help card */
.fm-help{border:1px solid var(--fm-line);border-radius:13px;padding:16px 18px 15px;
  background:rgba(7,11,16,.62);backdrop-filter:blur(14px) saturate(1.1);
  -webkit-backdrop-filter:blur(14px) saturate(1.1);max-width:430px;
  transition:border-color .3s ease,background .3s ease}
.fm-help__hd{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px}
.fm-help__hd b{font:600 11px/1 var(--fm-mono);letter-spacing:.2em;text-transform:uppercase;color:var(--fm-muted)}
.fm-help__hd em{font-style:normal;font-size:11px;color:var(--fm-dim)}
.fm-keys{display:grid;grid-template-columns:auto 1fr;gap:8px 14px;margin:0;font-size:13px}
.fm-keys dt{display:flex;gap:4px;align-items:center}
.fm-keys dd{margin:0;color:var(--fm-muted);align-self:center}
.fm-k{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;
  padding:0 6px;border-radius:5px;border:1px solid var(--fm-line-2);border-bottom-width:2px;
  background:rgba(255,255,255,.07);font:600 11px/1 var(--fm-mono);color:#dbe6f0;white-space:nowrap}
.fm-help__tip{display:flex;gap:9px;align-items:flex-start;margin:14px 0 0;padding-top:13px;
  border-top:1px solid var(--fm-line);font-size:13px;line-height:1.5;color:#d6e3ee}
.fm-help__tip b{color:var(--fm-accent);font-weight:600}
.fm-help[data-emph="1"]{border-color:rgba(87,200,247,.45);background:rgba(9,20,28,.74)}

/* ------------------------------------------------------------------- panel */
.fm-panel{position:relative;box-sizing:border-box;border-radius:16px;padding:22px 22px 18px;
  background:linear-gradient(180deg,var(--fm-panel),var(--fm-panel-2));
  border:1px solid var(--fm-line);
  box-shadow:0 44px 110px -34px rgba(0,0,0,.95),inset 0 1px 0 rgba(255,255,255,.07);
  backdrop-filter:blur(22px) saturate(1.2);-webkit-backdrop-filter:blur(22px) saturate(1.2);
  max-height:100%;overflow:auto;overscroll-behavior:contain}
.fm-panel__hd{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:16px}
.fm-panel__hd h2{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}
.fm-panel__hd span{font:500 11px/1 var(--fm-mono);letter-spacing:.16em;text-transform:uppercase;color:var(--fm-dim)}

/* ------------------------------------------------------------------ fields */
.fm-fields{display:grid;grid-template-columns:1fr 152px;gap:12px;margin-bottom:16px}
.fm-field{display:flex;flex-direction:column;gap:7px;min-width:0}
.fm-field>label,.fm-legend{font:600 10px/1 var(--fm-mono);letter-spacing:.18em;text-transform:uppercase;color:var(--fm-dim)}
.fm-input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;
  background:rgba(3,6,9,.62);color:var(--fm-text);border:1px solid var(--fm-line);
  font:400 15px/1.2 var(--fm-ui);transition:border-color .16s,box-shadow .16s,background .16s}
.fm-input::placeholder{color:#7d92a6}
.fm-input:hover{border-color:var(--fm-line-2)}
.fm-input:focus-visible,.fm-input:focus{outline:2px solid var(--fm-accent);outline-offset:1px;
  border-color:var(--fm-accent);background:rgba(3,6,9,.8)}
.fm-seedrow{display:flex;gap:7px}
.fm-seedrow .fm-input{font-family:var(--fm-mono);font-size:14px;letter-spacing:.06em;
  -moz-appearance:textfield;min-width:0}
.fm-seedrow .fm-input::-webkit-outer-spin-button,
.fm-seedrow .fm-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.fm-icon-btn{flex:0 0 40px;height:40px;display:grid;place-items:center;border-radius:9px;cursor:pointer;
  background:rgba(255,255,255,.05);border:1px solid var(--fm-line);color:#cfdce7;
  transition:border-color .16s,color .16s,background .16s,transform .3s ease}
.fm-icon-btn:hover{border-color:var(--fm-accent);color:#fff;background:rgba(87,200,247,.12)}
.fm-icon-btn:focus-visible{outline:2px solid var(--fm-accent);outline-offset:2px;border-color:var(--fm-accent);color:#fff}
.fm-icon-btn svg{width:17px;height:17px;display:block}
.fm-icon-btn[data-spin="1"] svg{animation:fm-spin .5s cubic-bezier(.4,0,.2,1)}
@keyframes fm-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}

/* ----------------------------------------------------------------- quality */
.fm-quality{border:0;padding:0;margin:0 0 18px;min-width:0}
.fm-legend{padding:0;margin-bottom:7px;display:block}
.fm-seg{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:3px;padding:3px;border-radius:10px;
  background:rgba(3,6,9,.62);border:1px solid var(--fm-line)}
.fm-seg input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.fm-seg label{display:block;text-align:center;padding:8px 4px;border-radius:7px;cursor:pointer;
  font-size:12.5px;font-weight:500;color:var(--fm-muted);border:1px solid transparent;
  transition:background .16s,color .16s}
.fm-seg label:hover{color:var(--fm-text);background:rgba(255,255,255,.05)}
.fm-seg input:checked+label{background:rgba(87,200,247,.17);border-color:rgba(87,200,247,.42);
  color:#dff3ff;font-weight:600}
.fm-seg input:focus-visible+label{outline:2px solid var(--fm-accent);outline-offset:1px;color:#dff3ff}
.fm-qnote{margin:8px 2px 0;font-size:12px;line-height:1.5;color:var(--fm-dim);min-height:18px}
.fm-qnote[data-ok="1"]{color:var(--fm-accent)}

/* ----------------------------------------------------------------- choices */
.fm-choices{display:grid;gap:10px}
.fm-choice{display:flex;align-items:center;gap:14px;width:100%;box-sizing:border-box;
  padding:11px 13px 11px 11px;border-radius:13px;cursor:pointer;text-align:left;font:inherit;
  background:rgba(255,255,255,.035);border:1px solid var(--fm-line);color:var(--fm-text);
  transition:border-color .18s,background .18s,transform .18s}
.fm-choice:hover{border-color:var(--fm-line-2);background:rgba(255,255,255,.07);transform:translateY(-1px)}
.fm-choice:focus-visible{outline:2px solid var(--fm-accent);outline-offset:2px;border-color:var(--fm-accent)}
.fm-choice--primary{background:linear-gradient(105deg,rgba(87,200,247,.15),rgba(87,200,247,.05));
  border-color:rgba(87,200,247,.34)}
.fm-choice--primary:hover{background:linear-gradient(105deg,rgba(87,200,247,.24),rgba(87,200,247,.08));
  border-color:rgba(87,200,247,.6)}
.fm-choice__thumb{position:relative;flex:0 0 108px;height:78px;border-radius:9px;overflow:hidden;
  background:#0d151d;border:1px solid rgba(255,255,255,.12);display:block}
.fm-choice__thumb canvas,.fm-choice__thumb img{display:block;width:100%;height:100%;object-fit:cover}
.fm-choice__tag{position:absolute;left:0;bottom:0;right:0;padding:3px 6px;
  font:600 9.5px/1.3 var(--fm-mono);letter-spacing:.1em;text-transform:uppercase;color:#e6f1f9;
  background:linear-gradient(to top,rgba(0,0,0,.78),rgba(0,0,0,0))}
.fm-choice__body{flex:1 1 auto;min-width:0;display:block}
.fm-choice__title{display:block;font-size:16px;font-weight:600;letter-spacing:-.01em;margin-bottom:3px}
.fm-choice__desc{display:block;font-size:12.5px;line-height:1.45;color:var(--fm-muted)}
.fm-choice__go{flex:0 0 auto;width:18px;height:18px;color:var(--fm-dim);transition:transform .18s,color .18s}
.fm-choice:hover .fm-choice__go{transform:translateX(3px);color:var(--fm-accent)}

.fm-foot{margin-top:14px;padding-top:12px;border-top:1px solid var(--fm-line);
  display:flex;justify-content:space-between;gap:10px;font:500 11px/1.4 var(--fm-mono);
  letter-spacing:.08em;color:var(--fm-dim);text-transform:uppercase}

/* ----------------------------------------------------------------- loading */
.fm-load{display:flex;flex-direction:column;gap:0}
.fm-load__eyebrow{font:600 10px/1 var(--fm-mono);letter-spacing:.2em;text-transform:uppercase;
  color:var(--fm-accent);margin-bottom:10px}
.fm-load__name{font-size:26px;font-weight:600;letter-spacing:-.02em;line-height:1.15;
  overflow-wrap:anywhere}
.fm-load__meta{margin-top:6px;font:500 12px/1.4 var(--fm-mono);letter-spacing:.06em;color:var(--fm-dim)}
.fm-bar{position:relative;height:4px;border-radius:3px;background:rgba(255,255,255,.09);
  overflow:hidden;margin:20px 0 10px}
.fm-bar>i{position:absolute;inset:0 auto 0 0;width:0;border-radius:3px;
  background:linear-gradient(90deg,#3aa7dd,var(--fm-accent));transition:width .35s cubic-bezier(.4,0,.2,1)}
.fm-status{display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--fm-muted);min-height:19px}
.fm-status i{flex:0 0 6px;height:6px;border-radius:50%;background:var(--fm-accent);
  animation:fm-pulse 1.5s ease-in-out infinite}
@keyframes fm-pulse{0%,100%{opacity:.35;transform:scale(.7)}50%{opacity:1;transform:scale(1)}}
.fm-load__pct{margin-left:auto;font:600 12px/1 var(--fm-mono);color:var(--fm-dim);letter-spacing:.06em}

/* -------------------------------------------------------------- applying q */
.fm-apply{position:absolute;inset:0;z-index:5;display:none;flex-direction:column;
  align-items:center;justify-content:center;gap:14px;border-radius:16px;
  background:rgba(6,10,14,.9);backdrop-filter:blur(4px)}
.fm-root[data-phase="applying"] .fm-apply{display:flex}
.fm-apply__ring{width:26px;height:26px;border-radius:50%;border:2px solid rgba(255,255,255,.16);
  border-top-color:var(--fm-accent);animation:fm-rot .8s linear infinite}
@keyframes fm-rot{to{transform:rotate(360deg)}}
.fm-apply__txt{font-size:13px;color:var(--fm-muted)}

.fm-root[data-phase="loading"] .fm-choose{display:none}
.fm-root[data-phase="loading"] .fm-bg{transform:scale(1.055);transition:transform 26s linear,opacity 1.1s ease}
@media (prefers-reduced-motion:reduce){.fm-root[data-phase="loading"] .fm-bg{transform:none}}
.fm-root:not([data-phase="loading"]) .fm-load{display:none}

/* --------------------------------------------------------------- responsive */
@media (max-width:1080px){
  .fm-stage{grid-template-columns:minmax(0,1fr) 400px;gap:32px}
  .fm-title{font-size:clamp(42px,5.4vw,60px)}
}
@media (max-width:880px){
  .fm-stage{grid-template-columns:minmax(0,1fr);align-items:start;align-content:start;
    gap:16px;padding:22px 16px 30px;overflow-y:auto;-webkit-overflow-scrolling:touch}
  .fm-left{display:contents}
  .fm-brand{order:1;max-width:none}
  .fm-panel{order:2;max-height:none;overflow:visible}
  .fm-help{order:3;max-width:none}
  .fm-kicker{margin-bottom:12px}
  .fm-title{font-size:clamp(40px,13vw,58px)}
  .fm-tag{margin-top:12px;font-size:14.5px;max-width:34ch}
  .fm-grade{background:
    linear-gradient(to bottom,rgba(4,7,10,.18) 0%,rgba(4,7,10,.52) 30%,rgba(4,7,10,.86) 74%,rgba(4,7,10,.94) 100%)}
}
@media (max-height:560px) and (min-width:881px){
  .fm-title{font-size:clamp(38px,4.6vw,54px)}
  .fm-tag{margin-top:12px;font-size:14px}
}

@media (prefers-reduced-motion:reduce){
  .fm-root,.fm-bg,.fm-choice,.fm-input,.fm-icon-btn,.fm-seg label,.fm-bar>i,.fm-choice__go,.fm-help{
    transition-duration:.01ms!important}
  .fm-status i,.fm-apply__ring,.fm-icon-btn[data-spin="1"] svg{animation:none!important}
  .fm-choice:hover{transform:none}
}
@media (forced-colors:active){
  .fm-choice,.fm-input,.fm-icon-btn,.fm-seg{border-color:ButtonBorder}
  .fm-seg input:checked+label{background:Highlight;color:HighlightText}
}

.fm-saved-worlds{margin-top:14px;padding:14px 16px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(10,15,20,.72);backdrop-filter:blur(18px)}
.fm-saved-worlds__heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;color:#f1f4f7;font-size:12px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}
.fm-saved-worlds__heading span{color:#84919d;font-size:10px;font-weight:500;letter-spacing:0;text-transform:none}
.fm-saved-worlds__list{display:grid;gap:7px;max-height:190px;overflow:auto}
.fm-saved-world{width:100%;min-height:58px;padding:10px 12px;text-align:left;background:rgba(255,255,255,.045);border-color:rgba(255,255,255,.1)}
.fm-saved-world .fm-choice__title{font-size:13px}
.fm-saved-world .fm-choice__desc{font-size:11px;color:#9ba7b2}
.fm-saved-world .fm-choice__go{font-size:22px}

`;

export function injectStyles() {
  if (document.getElementById('fm-menu-styles')) return;
  const el = document.createElement('style');
  el.id = 'fm-menu-styles';
  el.textContent = CSS;
  document.head.appendChild(el);
}
