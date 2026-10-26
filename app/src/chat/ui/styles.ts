// Chat styles, scoped under .bhc. Colors come from the shell's CSS variables; the fallbacks are
// the same palette so the panel also renders in the standalone preview.
export const CSS = `
.bhc{--c-void:var(--void,#000);--c-ash:var(--ash,#4a0d02);--c-crimson:var(--crimson,#9e1b07);--c-red:var(--redshift,#d7261e);
--c-ember:var(--ember,#ff6a00);--c-flare:var(--flare,#ffae42);--c-photon:var(--photon,#f5efe6);--c-text:var(--text,#f0dccb);
--c-dim:var(--dim,#a2735b);--c-bg1:var(--bg1,#060201);--c-bg2:var(--bg2,#0c0402);--c-line:var(--line,#1e0804);--c-line2:var(--line2,#2b0d05);
--c-sel:var(--sel,#2a0c04);--f-display:var(--font-display,'Chakra Petch',sans-serif);--f-ui:var(--font-ui,'IBM Plex Sans',system-ui,sans-serif);
--f-mono:var(--font-mono,'JetBrains Mono',monospace);color:var(--c-text);font-family:var(--f-ui);font-size:13px;box-sizing:border-box}
.bhc *,.bhc *::before,.bhc *::after{box-sizing:inherit}
.bhc-tab{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--c-void)}
.bhc-hd{font-family:var(--f-display);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--c-dim)}
.bhc-btn{height:30px;padding:0 12px;border-radius:4px;border:1px solid var(--c-ash);background:#120603;color:var(--c-text);font:500 12px var(--f-ui);cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.bhc-btn:hover{border-color:var(--c-crimson)}
.bhc-btn:focus-visible,.bhc input:focus-visible,.bhc textarea:focus-visible,.bhc select:focus-visible{outline:2px solid var(--c-flare);outline-offset:1px}
.bhc-btn[disabled]{opacity:.45;cursor:default}
.bhc-btn.pri{background:var(--c-ember);border-color:var(--c-ember);color:#000}
.bhc-btn.sm{height:24px;padding:0 8px}
.bhc-btn.ghost{background:none;border-color:transparent;color:var(--c-dim)}
.bhc-ico{display:inline-flex}
.bhc-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border:1px solid #3a1206;border-radius:4px;font-size:12px;color:var(--c-text);background:var(--c-bg2);white-space:nowrap}
.bhc-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--c-ash)}
.bhc-dot.ready{background:var(--c-ember)}.bhc-dot.starting,.bhc-dot.stopping{background:var(--c-flare);animation:bhc-blink 1s steps(1) infinite}
.bhc-dot.crashed{background:var(--c-red)}
@keyframes bhc-blink{50%{opacity:.25}}
.bhc-top{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--c-bg1);border-bottom:1px solid var(--c-line);flex-wrap:wrap}
.bhc-title{font-family:var(--f-display);font-weight:700;letter-spacing:.06em;font-size:15px;color:var(--c-photon);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.bhc-top select{height:28px;max-width:320px;background:#000;color:var(--c-text);border:1px solid #3a1206;border-radius:4px;font:12px var(--f-ui)}
.bhc-sp{flex:1}
.bhc-banner{display:flex;align-items:flex-start;gap:12px;padding:10px 16px;border-bottom:1px solid var(--c-ash);background:#1a0703;font-size:13px;line-height:19px;flex-wrap:wrap}
.bhc-banner.bad{background:#2a0705;border-color:var(--c-crimson)}
.bhc-banner b{color:var(--c-photon);font-weight:600}
.bhc-banner .bhc-sub{color:var(--c-dim);font-size:12px}
.bhc-banner .bhc-acts{margin-left:auto;display:flex;gap:8px}
.bhc-body{flex:1;min-height:0;display:flex}
.bhc-scroll{flex:1;min-width:0;overflow-y:auto;padding:20px 0 12px}
.bhc-col{max-width:820px;margin:0 auto;padding:0 20px;display:flex;flex-direction:column;gap:16px}
.bhc-empty{margin:12vh auto 0;max-width:460px;text-align:center;color:var(--c-dim);line-height:20px}
.bhc-hole{display:flex;justify-content:center;line-height:0;margin:0 0 18px}
.bhc-empty b{color:var(--c-photon);font-family:var(--f-display);letter-spacing:.06em;font-size:16px;display:block;margin-bottom:6px}
.bhc-user{align-self:flex-end;max-width:80%;background:#1a0703;border:1px solid #3a1206;border-radius:8px;padding:10px 12px;line-height:20px;white-space:pre-wrap;word-wrap:break-word}
.bhc-ai{line-height:21px;word-wrap:break-word}
.bhc-ai p{margin:0 0 10px}.bhc-ai p:last-child{margin-bottom:0}
.bhc-ai h3,.bhc-ai h4,.bhc-ai h5,.bhc-ai h6{font-family:var(--f-display);color:var(--c-photon);margin:14px 0 6px;letter-spacing:.03em}
.bhc-ai ul,.bhc-ai ol{margin:0 0 10px;padding-left:22px}
.bhc-ai code{font-family:var(--f-mono);font-size:12px;background:#1a0703;border:1px solid var(--c-line2);border-radius:3px;padding:0 4px;color:var(--c-flare)}
.bhc-ai pre{background:var(--c-bg1);border:1px solid var(--c-line2);border-radius:6px;padding:10px 12px;overflow-x:auto;margin:0 0 10px}
.bhc-ai pre code{background:none;border:0;padding:0;color:var(--c-text);font-size:12.5px;line-height:19px}
.bhc-ai a{color:var(--c-flare)}
.bhc-think{border:1px solid var(--c-line2);border-radius:6px;background:var(--c-bg1);margin-bottom:10px}
.bhc-think summary{cursor:pointer;padding:6px 10px;font-size:12px;color:var(--c-dim);list-style:none;display:flex;gap:8px;align-items:center}
.bhc-think summary::-webkit-details-marker{display:none}
.bhc-think summary::before{content:'▸';color:var(--c-ember)}
.bhc-think[open] summary::before{content:'▾'}
.bhc-think div{padding:0 12px 10px;font-family:var(--f-mono);font-size:12px;line-height:18px;color:#8f6450;white-space:pre-wrap;max-height:320px;overflow-y:auto}
.bhc-cur{display:inline-block;width:7px;height:15px;background:var(--c-ember);vertical-align:text-bottom;animation:bhc-blink 1s steps(1) infinite;margin-left:2px}
.bhc-stats{margin-top:6px;font-family:var(--f-mono);font-size:11px;color:var(--c-dim)}
.bhc-stats .fast{color:var(--c-flare)}
.bhc-note{font-size:12px;color:var(--c-flare)}
.bhc-err{font-size:12px;color:#ff8a7a}
.bhc-comp{border-top:1px solid var(--c-line);background:var(--c-bg2);padding:12px 0 10px}
.bhc-comp .bhc-col{gap:8px}
.bhc-comp textarea{width:100%;resize:none;background:#000;color:var(--c-text);border:1px solid #3a1206;border-radius:6px;padding:10px 12px;font:13px/20px var(--f-ui);min-height:44px;max-height:220px}
.bhc-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.bhc-meta{font-size:11px;color:var(--c-dim)}
.bhc-live{font-family:var(--f-mono);font-size:11px;color:var(--c-flare)}
.bhc-side[hidden]{display:none}
.bhc-side{width:320px;flex:none;border-left:1px solid var(--c-line);background:var(--c-bg2);overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.bhc-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--c-dim)}
.bhc-field input,.bhc-field textarea,.bhc-field select{background:#000;color:var(--c-text);border:1px solid #3a1206;border-radius:4px;padding:5px 8px;font:12px var(--f-ui)}
.bhc-field input[type=checkbox]{width:14px;height:14px;accent-color:var(--c-ember)}
.bhc-check{flex-direction:row;align-items:center;gap:8px;color:var(--c-text)}
.bhc-log{flex:1;min-height:200px;margin:0;font-family:var(--f-mono);font-size:11px;line-height:16px;color:var(--c-dim);white-space:pre-wrap;word-break:break-all;background:#000;border:1px solid var(--c-line2);border-radius:4px;padding:8px;overflow-y:auto}
.bhc-cmd{font-family:var(--f-mono);font-size:11px;color:var(--c-flare);word-break:break-all;background:#000;border:1px solid var(--c-line2);border-radius:4px;padding:6px 8px}
/* sidebar */
.bhc-sb{display:flex;flex-direction:column;gap:4px;padding:12px 0}
.bhc-sb-hd{display:flex;align-items:center;justify-content:space-between;padding:0 12px 6px}
.bhc-group{padding:10px 12px 4px}
.bhc-it{display:flex;align-items:center;gap:8px;min-height:30px;padding:3px 8px 3px 12px;font-size:13px;color:var(--c-text);cursor:pointer;border:0;background:none;width:100%;text-align:left;font-family:inherit}
.bhc-it:hover{background:#140602}
.bhc-it.sel{background:var(--c-sel);color:var(--c-photon)}
.bhc-it .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bhc-it .sz{font-size:11px;color:var(--c-dim);flex:none}
.bhc-tag{font-family:var(--f-mono);font-size:10px;padding:0 4px;border-radius:3px;border:1px solid var(--c-ash);color:var(--c-flare);flex:none}
.bhc-dl{padding:8px 12px;display:flex;flex-direction:column;gap:6px}
.bhc-dl input{width:100%;background:#000;color:var(--c-text);border:1px solid #3a1206;border-radius:4px;padding:5px 8px;font:12px var(--f-mono)}
.bhc-bar{height:4px;background:var(--c-line2);border-radius:2px;overflow:hidden}
.bhc-bar span{display:block;height:100%;background:var(--c-ember)}
.bhc-hint{font-size:11px;color:var(--c-dim);line-height:16px;padding:0 12px}
`;

let injected = false;
export function injectStyles(doc: Document = document): void {
  if (injected && doc.getElementById('bhc-styles')) return;
  const s = doc.createElement('style');
  s.id = 'bhc-styles';
  s.textContent = CSS;
  doc.head.append(s);
  injected = true;
}
