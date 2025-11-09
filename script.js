/* NetCheck frontend JS
   - Connects to backend server (set via input)
   - Measures ping via WebSocket / echo
   - Measures download speed by parallel fetches to /download?size=MB
   - Measures upload by POSTing generated blob to /upload
   - Displays real-time graph (simple canvas)
*/

(() => {
  // UI elements
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const downloadValue = document.getElementById('downloadValue');
  const uploadValue = document.getElementById('uploadValue');
  const pingValue = document.getElementById('pingValue');
  const serverInput = document.getElementById('serverUrl');
  const setServerBtn = document.getElementById('setServer');
  const detailServer = document.getElementById('detailServer');
  const detailWorkers = document.getElementById('detailWorkers');
  const detailChunks = document.getElementById('detailChunks');
  const canvas = document.getElementById('speedChart');
  const ctx = canvas.getContext('2d');

  // Defaults
  let serverBase = ''; // must be set by user; e.g. https://your-backend.com
  let ws = null;
  let running = false;

  let workers = 6; // parallel fetches
  let chunkMB = 2; // each chunk size in MB
  detailWorkers.textContent = workers;
  detailChunks.textContent = `${workers} × ${chunkMB}MB`;

  // Graph data
  let graphData = {labels:[], download:[], upload:[]};
  function drawGraph(){
    // Clear
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * devicePixelRatio;
    canvas.height = h * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.clearRect(0,0,w,h);

    // background grid
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    ctx.fillRect(0,0,w,h);

    // if no data
    if(!graphData.download.length){
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.font = '14px Inter, Arial';
      ctx.fillText('Start test to see real-time speeds', 16, 32);
      return;
    }

    // Find max
    const all = graphData.download.concat(graphData.upload);
    const max = Math.max(...all, 1);
    const pad = 20;
    const plotW = w - pad*2, plotH = h - pad*2;
    const stepX = plotW / Math.max(1, graphData.download.length - 1);

    // draw axes
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad, h-pad);
    ctx.lineTo(w-pad, h-pad);
    ctx.stroke();

    // draw download line
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = '#7c5cff';
    ctx.beginPath();
    graphData.download.forEach((v,i) => {
      const x = pad + i*stepX;
      const y = pad + plotH * (1 - Math.min(v/max,1));
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();

    // draw upload line
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = '#34d399';
    ctx.beginPath();
    graphData.upload.forEach((v,i) => {
      const x = pad + i*stepX;
      const y = pad + plotH * (1 - Math.min(v/max,1));
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();

    // labels
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '12px Inter, Arial';
    ctx.fillText(`${Math.round(max)} Mbps`, w - 80, pad + 12);
  }

  function setServer(url){
    serverBase = (url || '').replace(/\/+$/,'');
    detailServer.textContent = serverBase || 'Not set';
  }

  setServerBtn.addEventListener('click', () => {
    setServer(serverInput.value.trim());
  });

  // Ping using WebSocket echo
  async function measurePing(){
    if(!serverBase) return null;
    return new Promise((resolve) => {
      try {
        const wsURL = serverBase.replace(/^http/,'ws') + '/ws';
        const socket = new WebSocket(wsURL);
        let start = null;
        socket.onopen = () => {
          start = performance.now();
          socket.send(JSON.stringify({type:'ping', t: Date.now()}));
        };
        socket.onmessage = (ev) => {
          try{
            const data = JSON.parse(ev.data);
            if(data && data.type === 'pong'){
              const ms = Math.round(performance.now() - start);
              socket.close();
              resolve(ms);
            }
          }catch(e){
            socket.close();
            resolve(null);
          }
        };
        socket.onerror = () => { resolve(null); };
        setTimeout(()=>{ try{ socket.close(); }catch(e){}; resolve(null); }, 5000);
      }catch(e){ resolve(null); }
    });
  }

  // Download speed test
  async function measureDownload(){
    if(!serverBase) return null;
    // We'll start multiple fetches in parallel to /download?size=NN (MB)
    const url = serverBase + `/download?size=${chunkMB}`;
    const startAll = performance.now();
    let bytes = 0;
    const controllers = [];
    const fetches = [];
    for(let i=0;i<workers;i++){
      const ctrl = new AbortController();
      controllers.push(ctrl);
      const f = fetch(url, {signal: ctrl.signal}).then(async res => {
        if(!res.ok) throw new Error('bad');
        // read as stream to measure bytes arrived progressively
        const reader = res.body.getReader();
        while(true){
          const {done,value} = await reader.read();
          if(done) break;
          bytes += (value ? value.length : 0);
        }
      }).catch(e=>{
        // ignore per-connection errors
      });
      fetches.push(f);
    }
    // timeout safety 30s
    const raced = await Promise.race([
      Promise.all(fetches),
      new Promise((r)=>setTimeout(r,30000))
    ]);
    const duration = (performance.now() - startAll) / 1000; // seconds
    if(duration <= 0) return null;
    // bytes to megabits: bytes * 8 / 1e6
    const mbps = (bytes * 8) / 1e6 / duration;
    return Math.max(0, Math.round(mbps*10)/10);
  }

  // Upload speed test
  async function measureUpload(){
    if(!serverBase) return null;
    // generate a blob of N MB
    const sizeMB = chunkMB * workers;
    const bytesCount = sizeMB * 1024 * 1024;
    // generate random data in chunks (not to freeze UI)
    const chunk = 256 * 1024;
    const pieces = [];
    let remaining = bytesCount;
    while(remaining > 0){
      const take = Math.min(chunk, remaining);
      pieces.push(crypto.getRandomValues(new Uint8Array(take)));
      remaining -= take;
    }
    const blob = new Blob(pieces, {type:'application/octet-stream'});
    const url = serverBase + '/upload';
    const start = performance.now();
    try{
      const resp = await fetch(url, {method:'POST', body: blob});
      const duration = (performance.now() - start)/1000;
      if(!resp.ok) return null;
      const mbps = (bytesCount * 8) / 1e6 / duration;
      return Math.max(0, Math.round(mbps*10)/10);
    }catch(e){
      return null;
    }
  }

  // Main test runner
  async function runTestLoop(){
    running = true;
    startBtn.disabled = true; stopBtn.disabled = false;
    graphData = {labels:[], download:[], upload:[]};
    drawGraph();

    // ping first
    const ping = await measurePing();
    pingValue.textContent = (ping === null) ? '— ms' : `${ping} ms`;

    // Run 3 rounds for smoothing
    for(let round=0; round<4 && running; round++){
      // Download
      downloadValue.textContent = '… Mbps';
      const dl = await measureDownload();
      downloadValue.textContent = (dl === null) ? '— Mbps' : `${dl} Mbps`;

      // Upload
      uploadValue.textContent = '… Mbps';
      const ul = await measureUpload();
      uploadValue.textContent = (ul === null) ? '— Mbps' : `${ul} Mbps`;

      // push to graph
      graphData.labels.push(new Date().toLocaleTimeString());
      graphData.download.push(dl || 0);
      graphData.upload.push(ul || 0);
      drawGraph();
      // small pause
      await new Promise(r => setTimeout(r, 800));
    }

    startBtn.disabled = false; stopBtn.disabled = true;
    running = false;
  }

  startBtn.addEventListener('click', async () => {
    if(!serverBase){
      alert('Set backend server URL first (e.g. https://your-backend.com). Use the Flask server provided in /backend.');
      return;
    }
    runTestLoop();
  });

  stopBtn.addEventListener('click', () => {
    running = false;
    startBtn.disabled = false; stopBtn.disabled = true;
  });

  // default: try same host if site is served from backend
  (function tryAutoSet(){
    const auto = location.origin;
    // If frontend loaded from file:/// then leave blank
    if(auto.startsWith('http')){
      // if path contains / (i.e. frontend hosted separately) don't auto set
      // Leave empty — user should set backend
    }
  })();

  // initial draw
  drawGraph();
})();
