'use strict';

function generateDashboardHTML(options) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>nextlimiter dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --card: #161b22;
    --text: #c9d1d9;
    --accent: #58a6ff;
    --border: #30363d;
    --red: #f85149;
    --green: #2ea043;
    --yellow: #d29922;
    --font: 'Courier New', monospace;
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    margin: 0;
    padding: 20px;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border);
    padding-bottom: 10px;
    margin-bottom: 20px;
  }
  .title {
    font-size: 24px;
    font-weight: bold;
    color: var(--accent);
  }
  .controls {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    display: inline-block;
  }
  .dot.green { background: var(--green); }
  .dot.red { background: var(--red); }
  .btn {
    background: var(--card);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 12px;
    font-family: inherit;
    cursor: pointer;
    border-radius: 4px;
  }
  .btn:hover { background: var(--border); }
  .btn.danger { color: var(--red); border-color: var(--red); }
  .btn.danger:hover { background: rgba(248, 81, 73, 0.1); }
  
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 15px;
    margin-bottom: 20px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    padding: 15px;
    border-radius: 6px;
  }
  .card-title {
    font-size: 14px;
    color: #8b949e;
    margin-bottom: 10px;
  }
  .card-val {
    font-size: 28px;
    font-weight: bold;
  }
  
  .chart-container {
    background: var(--card);
    border: 1px solid var(--border);
    padding: 15px;
    border-radius: 6px;
    margin-bottom: 20px;
    height: 200px;
    position: relative;
  }
  
  .tables {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    gap: 20px;
  }
  .table-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 15px;
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 10px;
  }
  th, td {
    padding: 8px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  th {
    color: #8b949e;
    cursor: pointer;
    user-select: none;
  }
  th:hover { color: var(--text); }
  tr.highlight td { color: var(--red); }
  
</style>
</head>
<body>

<div class="header">
  <div class="title">nextlimiter dashboard</div>
  <div class="controls">
    <span id="timestamp"></span>
    <span id="statusDot" class="dot red"></span>
    <button id="pauseBtn" class="btn">Pause Updates</button>
    <button id="resetAllBtn" class="btn danger" onclick="resetAll()">Reset All Blocks</button>
  </div>
</div>

<div class="cards">
  <div class="card">
    <div class="card-title">Total Requests</div>
    <div id="valTotal" class="card-val">0</div>
  </div>
  <div class="card">
    <div class="card-title">Blocked Requests</div>
    <div id="valBlocked" class="card-val" style="color: var(--text);">0</div>
  </div>
  <div class="card">
    <div class="card-title">Block Rate %</div>
    <div id="valRate" class="card-val" style="color: var(--green);">0.0%</div>
  </div>
  <div class="card">
    <div class="card-title">Uptime</div>
    <div id="valUptime" class="card-val">0s</div>
  </div>
</div>

<div class="chart-container" id="sparkline">
  <!-- SVG injected here -->
</div>

<div class="tables">
  <div class="table-card">
    <div class="card-title">Top 10 Blocked IPs</div>
    <table id="tblBlocked">
      <thead><tr><th onclick="sortTbl('tblBlocked', 0)">IP / Key</th><th onclick="sortTbl('tblBlocked', 1)">Count</th><th onclick="sortTbl('tblBlocked', 2)">%</th><th>Action</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <div class="table-card">
    <div class="card-title">Top 10 Keys by Volume</div>
    <table id="tblVol">
      <thead><tr><th onclick="sortTbl('tblVol', 0)">Key</th><th onclick="sortTbl('tblVol', 1)">Requests</th><th>Action</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>

<script>
  let es = null;
  let isPaused = false;
  let historyData = [];
  let sortState = { tblBlocked: [1, false], tblVol: [1, false] };

  const basePath = window.location.pathname.replace(/\/$/, '');

  function parseUptime(ms) {
    if (!ms) return '0s';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function mountSvgChart(containerId, historyArr) {
    const container = document.getElementById(containerId);
    if (!historyArr || historyArr.length === 0) {
      container.innerHTML = '<div style="color:#8b949e; text-align:center; padding-top:80px;">Awaiting data...</div>';
      return;
    }
    
    // Compute diffs
    const diffs = [];
    for (let i = 1; i < historyArr.length; i++) {
        const prev = historyArr[i-1].stats;
        const curr = historyArr[i].stats;
        const allowedDiff = Math.max(0, curr.totalRequests - prev.totalRequests - (curr.blockedRequests - prev.blockedRequests));
        const blockedDiff = Math.max(0, curr.blockedRequests - prev.blockedRequests);
        diffs.push({ a: allowedDiff, b: blockedDiff });
    }
    if (diffs.length === 0) return;

    let maxVal = 10;
    diffs.forEach(d => {
        if (d.a + d.b > maxVal) maxVal = d.a + d.b;
    });

    const w = container.clientWidth - 20;
    const h = container.clientHeight - 40;
    const pxPerStep = w / Math.max(1, diffs.length - 1);

    let ptsA = '0,'+h+' ';
    let ptsB = '0,'+h+' ';

    diffs.forEach((d, i) => {
        const x = i * pxPerStep;
        const ya = h - ((d.a / maxVal) * h);
        const yb = h - ((d.b / maxVal) * h);
        ptsA += x+','+ya+' ';
        ptsB += x+','+yb+' ';
    });
    
    const lastX = (diffs.length-1)*pxPerStep;
    ptsA += lastX+','+h; // close path for area
    ptsB += lastX+','+h;

    const svg = '<svg width="100%" height="100%" viewBox="-10 -20 ' + (container.clientWidth) + ' ' + (container.clientHeight) + '">'+
      '<text x="0" y="-5" fill="#8b949e" font-size="12">Requests / interval (Max: '+maxVal+')</text>'+
      '<polyline fill="rgba(46,160,67,0.2)" stroke="#2ea043" stroke-width="2" points="'+ptsA+'" />'+
      '<polyline fill="rgba(248,81,73,0.3)" stroke="#f85149" stroke-width="2" points="'+ptsB+'" />'+
    '</svg>';
    
    container.innerHTML = svg;
  }

  function renderTable(tableId, data, isBlockedTbl) {
    const tbody = document.querySelector('#' + tableId + ' tbody');
    tbody.innerHTML = '';
    
    const [sortCol, asc] = sortState[tableId];
    data.sort((a,b) => {
        let valA, valB;
        if (sortCol === 0) { valA = a.key; valB = b.key; }
        else if (sortCol === 1) { valA = a.count; valB = b.count; }
        else if (sortCol === 2) { valA = a.rate; valB = b.rate; }
        if (valA < valB) return asc ? -1 : 1;
        if (valA > valB) return asc ? 1 : -1;
        return 0;
    });

    let html = '';
    data.forEach(row => {
        const hl = row.count > 1000 && isBlockedTbl ? 'highlight' : '';
        const pct = isBlockedTbl ? '<td>' + (row.rate*100).toFixed(1) + '%</td>' : '';
        html += '<tr class="'+hl+'">'+
          '<td>'+row.key+'</td>'+
          '<td>'+row.count+'</td>'+
          pct +
          '<td><button class="btn" style="padding: 2px 8px;" onclick="resetKey(\\''+encodeURIComponent(row.key)+'\\')">Reset</button></td>'+
        '</tr>';
    });
    tbody.innerHTML = html;
  }

  function sortTbl(tableId, colIndex) {
    if (sortState[tableId][0] === colIndex) {
        sortState[tableId][1] = !sortState[tableId][1];
    } else {
        sortState[tableId] = [colIndex, false];
    }
    updateAllPanels(historyData[historyData.length-1].stats);
  }

  function updateAllPanels(stats) {
    const d = new Date();
    document.getElementById('timestamp').innerText = d.toLocaleTimeString();

    document.getElementById('valTotal').innerText = stats.totalRequests || 0;
    document.getElementById('valBlocked').innerText = stats.blockedRequests || 0;
    document.getElementById('valBlocked').style.color = stats.blockedRequests > 0 ? 'var(--red)' : 'var(--text)';
    
    const blockRate = stats.totalRequests ? (stats.blockedRequests / stats.totalRequests) : 0;
    const rateTxt = (blockRate * 100).toFixed(2) + '%';
    document.getElementById('valRate').innerText = rateTxt;
    document.getElementById('valRate').style.color = blockRate > 0.15 ? 'var(--red)' : (blockRate > 0.05 ? 'var(--yellow)' : 'var(--green)');
    
    document.getElementById('valUptime').innerText = parseUptime(stats.uptimeMs);

    // Map top objects to array for table renderer
    const topBlockedSource = Array.isArray(stats.topBlocked) ? stats.topBlocked : [];
    const bArr = topBlockedSource.map(item => ({ key: item.key, count: item.count, rate: stats.blockedRequests ? item.count/stats.blockedRequests : 0 })).slice(0, 10);
    renderTable('tblBlocked', bArr, true);

    const topKeysSource = Array.isArray(stats.topKeys) ? stats.topKeys : [];
    const vArr = topKeysSource.map(item => ({ key: item.key, count: item.count })).slice(0, 10);
    renderTable('tblVol', vArr, false);

    mountSvgChart('sparkline', historyData);
  }

  async function resetKey(keyUri) {
    try {
        await fetch(basePath + '/api/reset/' + keyUri, { method: 'POST' });
        // Assume successful reset, next SSE tick will update UI
    } catch(err) {
        console.error(err);
    }
  }

  async function resetAll() {
    if (!historyData.length) return;
    const stats = historyData[historyData.length-1].stats;
    const items = Array.isArray(stats.topBlocked) ? stats.topBlocked : [];
    for (let i=0; i < items.length; i++) {
        await resetKey(encodeURIComponent(items[i].key));
    }
  }

  function showDisconnectedState() {
     document.getElementById('statusDot').className = 'dot red';
  }

  function fetchHistory() {
      fetch(basePath + '/api/history').then(r=>r.json()).then(data => {
          historyData = data;
          if (historyData.length) {
              updateAllPanels(historyData[historyData.length-1].stats);
          }
      }).catch(() => showDisconnectedState());
  }

  function connectSSE() {
      es = new EventSource(basePath + '/api/stream');
      es.onmessage = (e) => {
          if (isPaused) return;
          const stats = JSON.parse(e.data);
          historyData.push({ timestamp: Date.now(), stats });
          if (historyData.length > 60) historyData.shift();
          
          document.getElementById('statusDot').className = 'dot green';
          updateAllPanels(stats);
      };
      es.onerror = () => {
          showDisconnectedState();
          es.close();
          setTimeout(connectSSE, 5000);
      };
  }

  document.getElementById('pauseBtn').addEventListener('click', (e) => {
      isPaused = !isPaused;
      e.target.innerText = isPaused ? 'Resume Updates' : 'Pause Updates';
      e.target.style.background = isPaused ? 'var(--border)' : 'var(--card)';
      document.getElementById('statusDot').className = isPaused ? 'dot yellow' : 'dot green';
  });

  fetchHistory();
  connectSSE();
</script>
</body>
</html>`;
}

module.exports = { generateDashboardHTML };
