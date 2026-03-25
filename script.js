
  // iOS PWA launch guard — runs before anything else
  // iOS ignores manifest start_url and uses saved URL instead
  // If launched as standalone from wrong path, immediately redirect
  (function() {
    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    var isStandalone = window.navigator.standalone === true;
    var path = window.location.pathname;
    var correctPath = '/weekly-tracker/';
    if (isIOS && isStandalone && path !== correctPath && !path.startsWith(correctPath)) {
      window.location.replace(correctPath);
      throw new Error('redirecting'); // stop rest of script from running
    }
  })();


// ── State ─────────────────────────────────────────────────────
let tasks = JSON.parse(localStorage.getItem('wtt_tasks') || '[]');
let filter = 'all', category = 'all', newTaskCat = 'work';
let activeTaskId = null;
let settingsOpen = false, reportOpen = false;
let reportText = '';
let pendingScheduleDate = null;
let pendingPriority = 'medium';
const SYNC_POLL_MS = 60000;
let syncPromise = null;
let syncTimer = null;
const syncChannel = ('BroadcastChannel' in window) ? new BroadcastChannel('wtt-sync') : null;

const taskInput = document.getElementById('taskInput');
taskInput.addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });

// ── Date utils ─────────────────────────────────────────────────
function toDateKey(date) {
  // Returns YYYY-MM-DD string in local time
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function todayKey() { return toDateKey(new Date()); }

function tomorrowKey() {
  const d = new Date(); d.setDate(d.getDate()+1); return toDateKey(d);
}

function getWeekDays() {
  const days = [];
  const today = new Date();
  today.setHours(0,0,0,0);
  for (let i = 0; i < 8; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(d);
  }
  return days;
}

function formatDateKey(key) {
  if (!key) return 'Unscheduled';
  const tk = todayKey(), tmk = tomorrowKey();
  if (key === tk) return 'Today';
  if (key === tmk) return 'Tomorrow';
  const d = new Date(key + 'T00:00:00');
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]} · ${months[d.getMonth()]} ${d.getDate()}`;
}

function isOverdue(key) {
  if (!key) return false;
  return key < todayKey();
}

function shortDay(d) {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}

function shortDate(d) {
  return `${d.getMonth()+1}/${d.getDate()}`;
}

// ── Settings ───────────────────────────────────────────────────
function toggleSettings() {
  settingsOpen = !settingsOpen;
  document.getElementById('settingsPanel').classList.toggle('open', settingsOpen);
  document.getElementById('settingsBtn').classList.toggle('active', settingsOpen);
  if (settingsOpen) {
    const pi = document.getElementById('proxyUrlInput');
    if (pi) pi.value = localStorage.getItem('wtt_proxy') || '';
    renderSyncSettings();
    renderWorkflowSettings();
    if ('Notification' in window) updateNotifUI(Notification.permission);
  }
}

function getWorkflowPrefs() {
  return JSON.parse(localStorage.getItem('wtt_workflow') || '{}');
}

function isAutoArchiveOn() {
  return !!getWorkflowPrefs().autoArchiveDone;
}

function renderWorkflowSettings() {
  const toggle = document.getElementById('autoArchiveToggle');
  if (toggle) toggle.classList.toggle('on', isAutoArchiveOn());
}

function toggleAutoArchive() {
  const prefs = getWorkflowPrefs();
  prefs.autoArchiveDone = !prefs.autoArchiveDone;
  localStorage.setItem('wtt_workflow', JSON.stringify(prefs));
  renderWorkflowSettings();
  showSyncIndicator(prefs.autoArchiveDone ? '✓ Auto-archive on' : 'Auto-archive off');
}

let actionMenuContext = null;

function handleActionOverlayClick(e) {
  if (e.target === document.getElementById('actionOverlay')) closeActionMenu();
}

function closeActionMenu() {
  document.getElementById('actionOverlay').classList.remove('open');
  actionMenuContext = null;
  if (!archiveOpen && !document.getElementById('modalOverlay').classList.contains('open')) document.body.style.overflow = '';
}

function renderActionMenu() {
  const list = document.getElementById('actionSheetList');
  const title = document.getElementById('actionSheetTitle');
  if (!actionMenuContext || !list || !title) return;
  if (actionMenuContext.type === 'task') {
    const t = tasks.find(x => x.id === actionMenuContext.id);
    if (!t) return closeActionMenu();
    title.textContent = '// task actions';
    list.innerHTML = `
      <button class="action-sheet-btn" onclick="closeActionMenu();openModal(${t.id})"><span>Edit task</span><span class="meta">open details</span></button>
      <button class="action-sheet-btn accent" onclick="archiveSingleTask(${t.id})" ${t.blocked ? 'disabled' : ''}><span>Archive task</span><span class="meta">history</span></button>
      <button class="action-sheet-btn" onclick="setTaskBlockedState(${t.id}, ${t.blocked ? 'false' : 'true'})"><span>${t.blocked ? 'Unblock task' : 'Mark blocked'}</span><span class="meta">status</span></button>
      <button class="action-sheet-btn danger" onclick="closeActionMenu();askDelete(${t.id})"><span>Delete task</span><span class="meta">remove</span></button>`;
  } else if (actionMenuContext.type === 'archive') {
    const key = String(actionMenuContext.key).replace(/'/g, "\'");
    title.textContent = '// archive actions';
    list.innerHTML = `
      <button class="action-sheet-btn" onclick="closeActionMenu();editArchivedTaskDate('${key}')"><span>Edit done date</span><span class="meta">history</span></button>
      <button class="action-sheet-btn accent" onclick="closeActionMenu();restoreArchivedTask('${key}')"><span>Restore task</span><span class="meta">active list</span></button>
      <button class="action-sheet-btn danger" onclick="closeActionMenu();deleteArchivedTask('${key}')"><span>Delete from archive</span><span class="meta">remove</span></button>`;
  }
}

function openTaskMenu(id) {
  actionMenuContext = { type: 'task', id };
  renderActionMenu();
  document.getElementById('actionOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function openArchiveMenu(archiveKey) {
  actionMenuContext = { type: 'archive', key: archiveKey };
  renderActionMenu();
  document.getElementById('actionOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function setTaskBlockedState(id, blocked) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  t.blocked = !!blocked;
  if (blocked) {
    t.done = false;
    t.completedAt = null;
  }
  t.updatedAt = Date.now();
  save();
  render();
  pushIfConnected('task-block-state');
  closeActionMenu();
}

function maybeAutoArchiveTask(id) {
  if (!isAutoArchiveOn()) return;
  const t = tasks.find(x => x.id === id);
  if (!t || !t.done || t.blocked) return;
  setTimeout(() => archiveSingleTask(id, true), 180);
}

async function archiveSingleTask(id, fromAuto=false) {
  const found = tasks.find(x => x.id === id);
  if (!found) return;
  if (found.blocked) {
    showSyncIndicator('Blocked tasks cannot be archived');
    return;
  }
  const now = Date.now();
  const archivedTask = { ...found, done: true, blocked: false, completedAt: found.completedAt || now, updatedAt: now };
  setTombstone(archivedTask.id, now);
  tasks = tasks.filter(x => x.id !== id);
  save();
  render();
  if (sheetId && isTokenValid()) {
    await runFullSync('archive-single', { archiveList: [archivedTask] }).catch(() => archiveTasks([archivedTask]).catch(() => {}));
  } else {
    archiveTasks([archivedTask]).catch(() => {});
  }
  if (!fromAuto) showSyncIndicator('✓ Task archived');
  closeActionMenu();
}

function getProxyBaseUrl() {
  return (localStorage.getItem('wtt_proxy') || 'https://wtt-proxy.onrender.com').replace(/\/+$/, '');
}

function setAIStatus(connected, text) {
  const dot = document.getElementById('aiStatusDot');
  const statusText = document.getElementById('aiStatusText');
  const aiDot = document.getElementById('aiDot');
  if (dot) dot.classList.toggle('on', !!connected);
  if (statusText) statusText.textContent = text || (connected ? 'Connected via server' : 'Not connected');
  if (aiDot) aiDot.style.display = connected ? 'block' : 'none';
}

async function initAIStatus() {
  setAIStatus(false, 'Checking proxy...');
  try {
    const res = await fetch(getProxyBaseUrl() + '/', { method: 'GET' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Proxy unavailable');
    setAIStatus(true, data.message || 'Connected via server');
  } catch (err) {
    setAIStatus(false, 'Proxy unavailable');
  }
}

// ── Claude API ─────────────────────────────────────────────────
async function claudeCall(prompt, maxTokens = 300) {
  const proxyUrl = getProxyBaseUrl();
  const res = await fetch(proxyUrl + '/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || JSON.stringify(data));
  return data.content?.[0]?.text?.trim() || '';
}

async function detectPriority(text, cat) {
  try {
    const r = await claudeCall(
      `Classify this ${cat} task priority. Reply with ONE word only: HIGH, MEDIUM, or LOW.\n\nHIGH = urgent, deadline today, blocking others, critical\nMEDIUM = important this week, needs follow-up\nLOW = no deadline, optional, someday\n\nTask: "${text}"\n\nReply with one word:`,
      10
    );
    const match = r.toUpperCase().match(/HIGH|MEDIUM|LOW/);
    return match ? match[0].toLowerCase() : 'medium';
  } catch(e) { console.error('Priority:', e); }
  return 'medium';
}

async function polishNotes() {
  const btn = document.getElementById('btnPolishNote');
  btn.disabled = true; btn.textContent = 'Thinking...';

  const taskName = document.getElementById('modalTitleInput').value.trim();
  const raw = document.getElementById('notesArea').value.trim();
  const currentTag = document.getElementById('tagInput').value.trim();
  const t = tasks.find(t => t.id === activeTaskId);

  // Build context from all work tasks
  const workTasks = tasks.filter(t => t.category === 'work' && t.id !== activeTaskId);
  const existingTags = [...new Set(workTasks.map(t => t.tag).filter(Boolean))];
  const relatedTasks = workTasks
    .filter(wt => (currentTag && wt.tag === currentTag) || (!currentTag && wt.scheduledDate === t?.scheduledDate))
    .slice(0, 5)
    .map(wt => wt.text);

  try {
    const prompt = `You are helping fill in details for a work task. Based on the context provided, do two things:

1. Write clean, professional notes for this task (2-3 sentences max)
2. Suggest the best #tag from existing tags, or propose a new short tag name

Task name: "${taskName}"
${raw ? `Existing notes: "${raw}"` : 'No notes yet.'}
${relatedTasks.length ? `Related tasks on same day/project: ${relatedTasks.join(', ')}` : ''}
${existingTags.length ? `Existing project tags: ${existingTags.join(', ')}` : ''}
${currentTag ? `Current tag: #${currentTag}` : ''}

Respond in this exact format:
NOTES: [your 2-3 sentence notes here]
TAG: [single tag word, no # symbol, use existing tag if it fits]`;

    const result = await claudeCall(prompt, 200);

    // Parse response
    const notesMatch = result.match(/NOTES:\s*(.+?)(?=TAG:|$)/si);
    const tagMatch = result.match(/TAG:\s*([a-zA-Z0-9_-]+)/i);

    if (notesMatch?.[1]) {
      const cleaned = notesMatch[1].trim().replace(/```[\s\S]*?```/g, '').replace(/`/g, '').trim();
      document.getElementById('notesArea').value = cleaned;
    }

    if (tagMatch?.[1] && !currentTag) {
      const suggestedTag = tagMatch[1].toLowerCase().replace(/\s+/g, '-');
      document.getElementById('tagInput').value = suggestedTag;
    }
  } catch(e) {
    // AI unavailable — apply rule-based cleanup if there are notes
    if (raw) {
      document.getElementById('notesArea').value = fixGrammar(raw);
    }
  }
  btn.disabled = false; btn.textContent = '✦ Auto-fill';
}

// ── Rule-based grammar fixer (no AI needed) ───────────────────
function fixGrammar(text) {
  if (!text || text.length < 3) return text;
  let s = text.trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  s = s.replace(/\bi\b/g, 'I');
  s = s.replace(/\bi'm\b/gi, "I'm");
  s = s.replace(/\bi've\b/gi, "I've");
  s = s.replace(/\bi'll\b/gi, "I'll");
  s = s.replace(/  +/g, ' ');
  s = s.replace(/^(basically|actually|just|so|well|ok|okay),?\s+/i, '');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (s.length > 4 && !/[.!?]$/.test(s)) s += '.';
  s = s.replace(/\bwasnt\b/gi, "wasn't");
  s = s.replace(/\bdidnt\b/gi, "didn't");
  s = s.replace(/\bdoesnt\b/gi, "doesn't");
  s = s.replace(/\bcant\b/gi, "can't");
  s = s.replace(/\bwont\b/gi, "won't");
  s = s.replace(/\bisnt\b/gi, "isn't");
  s = s.replace(/\barent\b/gi, "aren't");
  s = s.replace(/\bhasnt\b/gi, "hasn't");
  s = s.replace(/\bhavent\b/gi, "haven't");
  s = s.replace(/ — ([a-z])/g, (_, ch) => ' — ' + ch.toUpperCase());
  return s;
}
function fixGrammarLines(lines) { return lines.map(l => fixGrammar(l)); }

// ── Report ─────────────────────────────────────────────────────
let activeReportType = 'daily';
let aiReportEnabled = localStorage.getItem('wtt_ai_report') !== 'off';

function toggleReport(event) {
  const overlay = document.getElementById('reportOverlay');
  if (overlay.classList.contains('open')) { closeReport(); return; }

  // Position card below the banner button
  if (event) {
    const btn = event.target.closest('button') || event.target;
    const rect = btn.getBoundingClientRect();
    const top = rect.bottom + 8;
    document.getElementById('reportOverlay').style.setProperty('--report-top', top + 'px');
    document.getElementById('reportCard').style.top = (top) + 'px';
  }

  overlay.classList.add('open');
  document.getElementById('reportBtn')?.classList.add('active');
  document.body.style.overflow = 'hidden';
  setReportType(activeReportType);
  const tog = document.getElementById('aiToggle');
  if (tog) tog.classList.toggle('on', aiReportEnabled);
}

function closeReport() {
  document.getElementById('reportOverlay').classList.remove('open');
  document.getElementById('reportBtn')?.classList.remove('active');
  document.body.style.overflow = '';
}

function handleReportOverlayClick(e) {
  if (e.target === document.getElementById('reportOverlay')) closeReport();
}

// Prevent backdrop scroll bleed on iOS
document.getElementById('reportOverlay')?.addEventListener('touchmove', e => {
  if (e.target.closest('.report-card')) return; // allow card to scroll
  e.preventDefault();
}, { passive: false });

function setReportType(type) {
  activeReportType = type;
  document.getElementById('typeBtnDaily')?.classList.toggle('active', type === 'daily');
  document.getElementById('typeBtnWeekly')?.classList.toggle('active', type === 'weekly');
  const dateEl = document.getElementById('reportDate');
  if (type === 'daily') {
    dateEl.textContent = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  } else {
    const { start, end } = getWeekWindow();
    const s = new Date(start+'T00:00:00'), e2 = new Date(end+'T00:00:00');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    dateEl.textContent = `${months[s.getMonth()]} ${s.getDate()} – ${months[e2.getMonth()]} ${e2.getDate()}`;
  }
  document.getElementById('reportBody').innerHTML = `<div class="report-generating">Tap Generate to create your ${type} report</div>`;
  document.getElementById('copyReportBtn').style.display = 'none';
  reportText = '';
}

function toggleAI() {
  aiReportEnabled = !aiReportEnabled;
  localStorage.setItem('wtt_ai_report', aiReportEnabled ? 'on' : 'off');
  document.getElementById('aiToggle')?.classList.toggle('on', aiReportEnabled);
}

function runReport() {
  if (activeReportType === 'weekly') generateWeeklyReport();
  else generateReport();
}

async function generateReport() {
  document.getElementById('reportBody').innerHTML = `<div class="report-generating">Building report...</div>`;
  document.getElementById('copyReportBtn').style.display = 'none';

  const tk = todayKey(), tmk = tomorrowKey();
  const workTasks = tasks.filter(t => t.category === 'work');
  const completedToday = workTasks.filter(t => t.done && t.completedAt && toDateKey(new Date(t.completedAt)) === tk);
  const scheduledTomorrow = workTasks.filter(t => !t.done && !t.blocked && t.scheduledDate === tmk);
  const blockedTasks = workTasks.filter(t => t.blocked);
  const overdueWork = workTasks.filter(t => !t.done && !t.blocked && t.scheduledDate && t.scheduledDate < tk);

  if (workTasks.length === 0) {
    document.getElementById('reportBody').innerHTML = `<div class="report-generating">No work tasks found yet.</div>`;
    return;
  }

  const today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  // ── Shared section structure ──
  const sections = [
    { label:'Completed',  mdLabel:'## Completed',  items:completedToday,   fallback:'No tasks completed today.',        required:true  },
    { label:'Blockers',   mdLabel:'## Blockers',   items:blockedTasks,      fallback:'No blockers reported.',             required:true  },
    { label:'Up Next',    mdLabel:'## Up Next',    items:scheduledTomorrow, fallback:'No tasks scheduled for tomorrow.', required:true  },
    { label:'Carry Over', mdLabel:'## Carry Over', items:overdueWork,       fallback:'',                                  required:false },
  ];

  // ── Build fallback report immediately (no API needed) ──
  function buildFallback() {
    let md = `# Daily Work Update\n${today}\n\n`;
    let html = '';
    for (const s of sections) {
      if (!s.items.length && !s.required) continue;
      const lines = s.items.length
        ? fixGrammarLines(s.items.map(t => t.notes ? `${t.text} — ${t.notes}` : t.text))
        : [s.fallback];
      const isFallback = !s.items.length;
      md += `${s.mdLabel}\n${lines.map(l=>`- ${l}`).join('\n')}\n\n`;
      html += `<div class="report-section">
        <div class="report-section-title">${s.label}</div>
        <div class="report-content">
          ${lines.map(l=>`<div class="report-row"><span class="report-bullet" style="${isFallback?'opacity:.3':''}">—</span><span style="${isFallback?'color:var(--muted)':''}">${escapeHtml(l)}</span></div>`).join('')}
        </div>
      </div><hr class="report-divider">`;
    }
    reportText = md.trim();
    return html;
  }

  // Show fallback immediately
  document.getElementById('reportBody').innerHTML = buildFallback();
  document.getElementById('copyReportBtn').style.display = 'inline-block';

  // ── Try AI enhancement silently (only if enabled) ──
  if (!aiReportEnabled) return;
  try {
    const payload = {
      completedToday: completedToday.map(t=>({task:t.text,notes:t.notes||''})),
      blockedTasks:   blockedTasks.map(t=>({task:t.text,notes:t.notes||''})),
      scheduledTomorrow: scheduledTomorrow.map(t=>({task:t.text,notes:t.notes||'',priority:t.priority||''})),
      overdue: overdueWork.map(t=>({task:t.text,notes:t.notes||''}))
    };
    const report = await claudeCall(`Write a professional end-of-day work update. Use the data below.

Data:
- Completed today: ${JSON.stringify(payload.completedToday)}
- Blocked tasks: ${JSON.stringify(payload.blockedTasks)}
- Scheduled tomorrow: ${JSON.stringify(payload.scheduledTomorrow)}
- Overdue: ${JSON.stringify(payload.overdue)}

Use these exact section markers with dash bullets. No intro text:

###COMPLETED###
- [bullet per completed task with notes as context. If none: No tasks completed today.]

###BLOCKERS###
- [bullet per blocked task with reason from notes. If none: No blockers reported.]

###TOMORROW###
- [bullet per tomorrow task ordered by priority. If none: No tasks scheduled for tomorrow.]

###CARRYOVER###
- [bullet per overdue task. Write NONE if none.]

Rules: professional tone, no emojis, concrete and specific, one sentence per bullet.`, 700);

    // Parse AI response and update display
    const aiSections = [
      { key:'###COMPLETED###', label:'Completed',  mdLabel:'## Completed',  required:true,  fallback:'No tasks completed today.' },
      { key:'###BLOCKERS###',  label:'Blockers',   mdLabel:'## Blockers',   required:true,  fallback:'No blockers reported.' },
      { key:'###TOMORROW###',  label:'Up Next',    mdLabel:'## Up Next',    required:true,  fallback:'No tasks scheduled for tomorrow.' },
      { key:'###CARRYOVER###', label:'Carry Over', mdLabel:'## Carry Over', required:false, fallback:'' },
    ];
    const parsed = {};
    for (let i=0; i<aiSections.length; i++) {
      const s = aiSections[i], next = aiSections[i+1]?.key;
      const m = report.match(new RegExp(`${s.key}\\s*([\\s\\S]*?)${next?`(?=${next})`:'$'}`));
      if (m) {
        const lines = fixGrammarLines(m[1].trim().split('\n').map(l=>l.trim().replace(/^[-•*]\s*/,'')).filter(l=>l.length>1&&l.toUpperCase()!=='NONE'));
        if (lines.length) { parsed[s.key]=lines; continue; }
      }
      if (s.required) parsed[s.key]=[s.fallback];
    }
    let md2 = `# Daily Work Update\n${today}\n\n`;
    let html2 = '';
    for (const s of aiSections) {
      if (!parsed[s.key]) continue;
      const isFb = parsed[s.key].length===1 && parsed[s.key][0]===s.fallback;
      md2 += `${s.mdLabel}\n${parsed[s.key].map(l=>`- ${l}`).join('\n')}\n\n`;
      html2 += `<div class="report-section">
        <div class="report-section-title">${s.label}</div>
        <div class="report-content">
          ${parsed[s.key].map(l=>`<div class="report-row"><span class="report-bullet" style="${isFb?'opacity:.3':''}">—</span><span style="${isFb?'color:var(--muted)':''}">${escapeHtml(l)}</span></div>`).join('')}
        </div>
      </div><hr class="report-divider">`;
    }
    if (html2) { reportText=md2.trim(); document.getElementById('reportBody').innerHTML=html2; }
  } catch(e) {
    // AI unavailable — fallback already showing, add subtle indicator
    const note = document.createElement('div');
    note.style.cssText = 'font-family:Space Mono,monospace;font-size:9px;color:var(--muted);margin-top:6px;text-align:center;padding:0 20px';
    note.textContent = '(basic summary — connect AI for enhanced report)';
    document.getElementById('reportBody').appendChild(note);
  }
}

function copyReport() {
  if (!reportText) return;
  navigator.clipboard.writeText(reportText).then(() => {
    const btn = document.getElementById('copyReportBtn');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied as Markdown';
    setTimeout(() => btn.textContent = orig, 2000);
  });
}

async function generateWeeklyReport() {
  document.getElementById('reportBody').innerHTML = `<div class="report-generating">Building weekly report...</div>`;
  document.getElementById('copyReportBtn').style.display = 'none';

  const { start: wStart, end: wEnd } = getWeekWindow();
  const workTasks = tasks.filter(t => t.category === 'work');

  if (workTasks.length === 0) {
    document.getElementById('reportBody').innerHTML = `<div class="report-generating">No work tasks found.</div>`;
    return;
  }

  const { start, end } = getWeekWindow();
  const s = new Date(start+'T00:00:00'), e2 = new Date(end+'T00:00:00');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const weekLabel = `${months[s.getMonth()]} ${s.getDate()} – ${months[e2.getMonth()]} ${e2.getDate()}`;

  // Completed this week — active tasks
  const completedWeek = workTasks.filter(t =>
    t.done && t.completedAt &&
    toDateKey(new Date(t.completedAt)) >= wStart &&
    toDateKey(new Date(t.completedAt)) <= wEnd
  );

  // Include archived tasks from localStorage cache (always available, no sheet load needed)
  const archiveCache = JSON.parse(localStorage.getItem('wtt_archivecache') || '[]');
  const archivedThisWeek = archiveCache.filter(t =>
    t.category === 'work' &&
    t.archivedDate >= wStart && t.archivedDate <= wEnd
  );
  // Merge, avoid duplicates
  const allCompleted = [...completedWeek];
  for (const t of archivedThisWeek) {
    if (!allCompleted.find(a => a.id === t.id)) allCompleted.push(t);
  }

  const incomplete = workTasks.filter(t => !t.done);

  // ── Extract #tags from task text ──
  function extractTag(t) {
    // Use stored tag field first, fall back to #tag in text
    if (t.tag) return t.tag.toLowerCase();
    const match = t.text.match(/#([a-zA-Z0-9_-]+)/);
    return match ? match[1].toLowerCase() : null;
  }

  function stripTag(text) {
    return text.replace(/#[a-zA-Z0-9_-]+/g, '').trim();
  }

  // ── Group tasks by tag ──
  function groupByTag(taskList) {
    const groups = new Map();
    for (const t of taskList) {
      const tag = extractTag(t) || '__untagged__';
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(t);
    }
    return groups;
  }

  // ── Build grouped report ──
  function buildGroupedReport() {
    const completedGroups = groupByTag(allCompleted);
    const incompleteGroups = groupByTag(incomplete);

    // Collect all unique tags across both
    const allTags = new Set([...completedGroups.keys(), ...incompleteGroups.keys()]);
    // Put tagged groups first, untagged last
    const sortedTags = [...allTags].filter(t => t !== '__untagged__').sort();
    if (allTags.has('__untagged__')) sortedTags.push('__untagged__');

    let md = `# Weekly Work Report\n${weekLabel}\n\n`;
    let html = '';

    // If no tags used at all — fall back to simple two-section format
    const hasTags = sortedTags.some(t => t !== '__untagged__');

    if (!hasTags) {
      // Simple format — no tags
      const sections = [
        { label:'Completed', mdLabel:'## Completed', items:allCompleted, fallback:'No tasks completed this week.' },
        { label:'Incomplete', mdLabel:'## Incomplete', items:incomplete, fallback:'No incomplete tasks.' },
      ];
      for (const sec of sections) {
        const lines = sec.items.length
          ? fixGrammarLines(sec.items.map(t => {
              const text = stripTag(t.text);
              return t.notes ? `${text} — ${t.notes}` : text;
            }))
          : [sec.fallback];
        const isFb = !sec.items.length;
        md += `${sec.mdLabel}\n${lines.map(l=>`- ${l}`).join('\n')}\n\n`;
        html += buildReportSection(sec.label, lines, isFb);
      }
    } else {
      // Grouped by tag format
      md += `## Summary by Project\n\n`;
      html += `<div class="report-section"><div class="report-section-title">By Project</div><div class="report-content">`;

      for (const tag of sortedTags) {
        const done = completedGroups.get(tag) || [];
        const todo = incompleteGroups.get(tag) || [];
        const total = done.length + todo.length;
        const tagLabel = tag === '__untagged__' ? 'Other tasks' : `#${tag}`;
        const blocked = todo.filter(t => t.blocked).length;

        // Progress indicator
        const pct = total > 0 ? Math.round((done.length / total) * 100) : 0;
        const statusColor = pct === 100 ? 'var(--low)' : blocked > 0 ? 'var(--high)' : 'var(--medium)';
        const statusText = pct === 100 ? '✓ Complete' : blocked > 0 ? `${blocked} blocked` : `${done.length}/${total} done`;

        md += `### ${tagLabel}\n`;
        html += `<div class="weekly-group">
          <div class="weekly-group-header">
            <span class="weekly-tag-label">${escapeHtml(tagLabel)}</span>
            <div class="weekly-progress-bar"><div class="weekly-progress-fill" style="width:${pct}%;background:${statusColor}"></div></div>
            <span class="weekly-status-text" style="color:${statusColor}">${statusText}</span>
          </div>`;

        // Done tasks
        if (done.length) {
          done.forEach(t => {
            const text = fixGrammar(stripTag(t.text));
            md += `- ✓ ${text}\n`;
            html += `<div class="report-row"><span class="report-bullet" style="color:var(--low)">✓</span><span style="opacity:.82">${escapeHtml(text)}</span></div>`;
          });
        }
        // Incomplete tasks
        if (todo.length) {
          todo.forEach(t => {
            const text = fixGrammar(stripTag(t.text));
            const badge = t.blocked ? ` <span style="color:var(--high);font-size:9px;border:1px solid rgba(255,92,92,.2);padding:1px 4px;border-radius:99px">BLOCKED</span>` : '';
            md += `- ${t.blocked ? '🚫 ' : '○ '}${text}\n`;
            html += `<div class="report-row"><span class="report-bullet" style="color:${t.blocked?'var(--high)':'var(--muted)'}">○</span><span style="color:#cfd5e5">${escapeHtml(text)}${badge}</span></div>`;
          });
        }

        md += '\n';
        html += `</div>`;
      }

      html += `</div></div><hr class="report-divider">`;

      // Summary stats
      const totalDone = allCompleted.length;
      const totalLeft = incomplete.length;
      const totalBlocked = incomplete.filter(t=>t.blocked).length;
      md += `## Stats\n- Completed: ${totalDone}\n- Remaining: ${totalLeft}\n- Blocked: ${totalBlocked}\n\n`;
      html += `<div class="report-section"><div class="report-section-title">Stats</div><div class="report-content">
        <div class="report-row"><span class="report-bullet" style="color:var(--low)">—</span><span>Completed: <strong>${totalDone}</strong></span></div>
        <div class="report-row"><span class="report-bullet">—</span><span>Remaining: <strong>${totalLeft}</strong></span></div>
        <div class="report-row"><span class="report-bullet" style="color:var(--high)">—</span><span>Blocked: <strong>${totalBlocked}</strong></span></div>
      </div></div>`;
    }

    reportText = md.trim();
    return html;
  }

  function buildReportSection(label, lines, isFallback) {
    return `<div class="report-section">
      <div class="report-section-title">${label}</div>
      <div class="report-content">
        ${lines.map(l=>`<div class="report-row"><span class="report-bullet" style="${isFallback?'opacity:.3':''}">—</span><span style="${isFallback?'color:var(--muted)':''}">${escapeHtml(l)}</span></div>`).join('')}
      </div>
    </div><hr class="report-divider">`;
  }

  document.getElementById('reportBody').innerHTML = buildGroupedReport();
  document.getElementById('copyReportBtn').style.display = 'inline-block';

  // ── Try AI enhancement (only if enabled) ──
  if (!aiReportEnabled) return;
  try {
    const payload = {
      weekLabel,
      completedThisWeek: allCompleted.map(t=>({task:t.text, notes:t.notes||'', priority:t.priority||''})),
      incomplete: incomplete.map(t=>({task:t.text, notes:t.notes||'', priority:t.priority||'', blocked:t.blocked||false})),
    };

    const report = await claudeCall(`Write a professional weekly work report grouped by project.

Tasks may have explicit #tags or no tags at all. For untagged tasks, infer the project/theme from the task name and notes and group them together. Name each group after its inferred project.

Data:
- Completed this week: ${JSON.stringify(payload.completedThisWeek)}
- Incomplete tasks: ${JSON.stringify(payload.incomplete)}

Instructions:
1. Group ALL tasks by project — use #tag if present, otherwise infer from context
2. For each project group write one concise sentence summarizing progress
3. Note any blocked tasks

Use these exact section markers:

###COMPLETED###
- [ProjectName: one sentence summary of what was completed]

###INCOMPLETE###
- [ProjectName: one sentence summary of what remains — note if blocked]

Rules: professional tone, no emojis, concrete, infer project names from task content.`, 700);

    const parsed = {};
    const defs = [
      {key:'###COMPLETED###', fallback:'No tasks completed this week.'},
      {key:'###INCOMPLETE###', fallback:'No incomplete tasks.'}
    ];
    for (let i=0; i<defs.length; i++) {
      const d = defs[i], next = defs[i+1]?.key;
      const m = report.match(new RegExp(`${d.key}\\s*([\\s\\S]*?)${next?`(?=${next})`:'$'}`));
      if (m) {
        const lines = m[1].trim().split('\n').map(l=>l.trim().replace(/^[-•*]\s*/,'')).filter(l=>l.length>1);
        if (lines.length) { parsed[d.key]=lines; continue; }
      }
      parsed[d.key]=[d.fallback];
    }

    const labels = {'###COMPLETED###':'Completed','###INCOMPLETE###':'Incomplete'};
    const mdLabels = {'###COMPLETED###':'## Completed','###INCOMPLETE###':'## Incomplete'};
    let md2 = `# Weekly Work Report\n${weekLabel}\n\n`;
    let html2 = '';
    for (const d of defs) {
      const isFb = parsed[d.key].length===1 && parsed[d.key][0]===d.fallback;
      md2 += `${mdLabels[d.key]}\n${parsed[d.key].map(l=>`- ${l}`).join('\n')}\n\n`;
      html2 += buildReportSection(labels[d.key], parsed[d.key], isFb);
    }
    if (html2) { reportText=md2.trim(); document.getElementById('reportBody').innerHTML=html2; }
  } catch(e) {
    const note = document.createElement('div');
    note.style.cssText = 'font-family:Space Mono,monospace;font-size:9px;color:var(--muted);margin-top:6px;text-align:center';
    note.textContent = '(AI unavailable — showing grouped summary)';
    document.getElementById('reportBody').appendChild(note);
  }
}




function toggleContextVoice() {} // removed

// ── Category / filter ──────────────────────────────────────────
function setCategory(cat, btn) {
  category = cat;
  document.querySelectorAll('.cat-tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); render();
  updateArchiveButton();
  renderCalendar();
}

function selectCat(cat) {
  newTaskCat = cat;
  document.getElementById('selWork').classList.toggle('active', cat==='work');
  document.getElementById('selPersonal').classList.toggle('active', cat==='personal');
}

function setFilter(f, btn) {
  filter = f;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); render();
  updateArchiveButton();
}

// ── Task CRUD ──────────────────────────────────────────────────
async function addTask() {
  const text = taskInput.value.trim(); if (!text) return;
  const id = Date.now();
  const task = { id, text, done:false, category:newTaskCat, createdAt:id, completedAt:null, scheduledDate:null, priority:'detecting', notes:'', blocked:false, tag:null, sortOrder:id };
  tasks.unshift(task); taskInput.value = '';
  save(); render();
  pushIfConnected('add-task'); // push new task to sheet immediately
  // Auto-open modal so user can set tag, schedule, priority
  openModal(id);
  // Detect priority in background
  const p = await detectPriority(text, newTaskCat);
  const t = tasks.find(t=>t.id===id);
  if (t && t.priority === 'detecting') { t.priority = p||'medium'; save(); render(); pushIfConnected('priority-detect'); }
}

function toggleTask(id) {
  const t = tasks.find(t=>t.id===id); if (!t) return;
  if (!t.done && !t.blocked) {
    t.done = true; t.blocked = false; t.completedAt = Date.now();
  } else if (t.done && !t.blocked) {
    t.done = false; t.blocked = true; t.completedAt = null;
  } else {
    t.done = false; t.blocked = false; t.completedAt = null;
  }
  t.updatedAt = Date.now();
  render();
  requestAnimationFrame(() => {
    save();
    pushIfConnected('toggle-task');
    if (t.done) {
      checkAllDone();
      maybeAutoArchiveTask(t.id);
    }
  });
}

function deleteTask(id) { setTombstone(id, Date.now()); tasks = tasks.filter(t=>t.id!==id); save(); render(); pushIfConnected('delete-task'); }

async function clearDone() {
  const toArchive = tasks.filter(t => t.done && !t.blocked && (category==='all' || t.category===category));
  if (toArchive.length === 0) return;
  const stamp = Date.now();
  toArchive.forEach(t => setTombstone(t.id, stamp));
  tasks = tasks.filter(t => !toArchive.find(a => a.id === t.id));
  save();
  render();
  if (sheetId && isTokenValid()) {
    await runFullSync('archive-completed', { archiveList: toArchive });
  } else {
    archiveTasks(toArchive).catch(() => {});
  }
}

function selectPriority(p) {
  pendingPriority = p;
  document.querySelectorAll('.priority-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.p === p);
  });
}

// ── Day Picker ─────────────────────────────────────────────────
function buildDayPicker(selectedDate) {
  const grid = document.getElementById('dayPickerGrid');
  const tk = todayKey();
  // Always show exactly 7 days starting from today
  const days = [];
  const cursor = new Date(tk + 'T00:00:00');
  for (let i = 0; i < 7; i++) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  let html = '';
  for (const d of days) {
    const key = toDateKey(d);
    const isToday = key === tk;
    const isActive = key === selectedDate;
    html += `<button class="day-pill${isToday?' today-pill':''}${isActive?' active':''}" onclick="selectDay('${key}')">
      <span class="pill-day">${shortDay(d)}</span>
      <span class="pill-date">${shortDate(d)}</span>
    </button>`;
  }
  grid.innerHTML = html;
}

function selectDay(key) {
  pendingScheduleDate = key;
  buildDayPicker(key);
}

// ── Modal ──────────────────────────────────────────────────────
function openModal(id, isNewWork = false) {
  const t = tasks.find(t=>t.id===id); if (!t) return;
  activeTaskId = id;
  pendingScheduleDate = t.scheduledDate || null;

  document.getElementById('modalTitleInput').value = t.text;
  document.getElementById('modalSubtitle').textContent = t.category==='work'?'🔵 Work Task':'🟣 Personal Task';
  document.getElementById('notesArea').value = t.notes || '';
  // Extract tag from task text and pre-fill tag input
  const existingTag = (t.text.match(/#([a-zA-Z0-9_-]+)/) || [])[1] || t.tag || '';
  document.getElementById('tagInput').value = existingTag;

  // Set priority selector
  const currentP = t.priority && ['high','medium','low'].includes(t.priority) ? t.priority : 'medium';
  document.querySelectorAll('.priority-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.p === currentP);
  });
  pendingPriority = currentP;

  buildDayPicker(t.scheduledDate || null);

  document.getElementById('modalTimestamps').innerHTML = `
    <div class="modal-ts"><div class="modal-ts-label">Added</div><div class="modal-ts-value">${formatTime(t.createdAt||t.id)}</div></div>
    ${t.completedAt?`<div class="modal-ts ts-done"><div class="modal-ts-label">Done</div><div class="modal-ts-value">${formatTime(t.completedAt)}</div></div>`:''}
    ${t.scheduledDate?`<div class="modal-ts"><div class="modal-ts-label">Scheduled</div><div class="modal-ts-value">${formatDateKey(t.scheduledDate)}</div></div>`:''}
  `;

  document.getElementById('modalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  activeTaskId = null; pendingScheduleDate = null;
}

async function saveModal() {
  const t = tasks.find(t=>t.id===activeTaskId);
  if (t) {
    const oldNotes = t.notes || '';
    const oldPriority = t.priority;
    // Rename
    const newTitle = document.getElementById('modalTitleInput').value.trim();
    if (newTitle) t.text = newTitle.replace(/#[a-zA-Z0-9_-]+/g, '').trim() || newTitle;
    // Tag
    const tagVal = document.getElementById('tagInput').value.trim().replace(/^#+/, '').replace(/[\s]+/g, '-').toLowerCase();
    t.tag = tagVal || null;
    // Notes — always save what the user typed (they intentionally cleared it)
    t.notes = document.getElementById('notesArea').value.trim();
    t.scheduledDate = pendingScheduleDate;
    t.priority = pendingPriority;
    t.updatedAt = Date.now();
    localStorage.setItem('wtt_tasks', JSON.stringify(tasks));
    render();
    pushIfConnected('save-modal'); // push on save
    if (t.notes !== oldNotes && t.priority === oldPriority && !t.done && !t.blocked) {
      const combined = `${t.text}. ${t.notes}`;
      const p = await detectPriority(combined, t.category);
      if (p) { t.priority = p; t.updatedAt = Date.now(); save(); render(); pushIfConnected('priority-detect'); }
    }
  }
  closeModal();
}

function handleOverlayClick(e) { if (e.target===document.getElementById('modalOverlay')) closeModal(); }
document.addEventListener('keydown', e => { if (e.key==='Escape') closeModal(); });

// ── Weekly window logic ────────────────────────────────────────
// The visible window is always Mon–Sun of the CURRENT week.
// On Sunday the NEXT week's tasks become visible too (next Mon–Sun).
// "This week" = Monday of current week → Sunday of current week.
function getWeekWindow() {
  const today = new Date();
  today.setHours(0,0,0,0);
  const dow = today.getDay(); // 0=Sun,1=Mon,...,6=Sat

  // Monday of this week
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));

  // Sunday of this week
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  // If today is Sunday, also show next week (next Mon–Sun)
  let windowEnd = sunday;
  if (dow === 0) {
    const nextSunday = new Date(sunday);
    nextSunday.setDate(sunday.getDate() + 7);
    windowEnd = nextSunday;
  }

  return { start: toDateKey(monday), end: toDateKey(windowEnd) };
}

function getWeekLabel() {
  const { start, end } = getWeekWindow();
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const today = new Date(); today.setHours(0,0,0,0);
  const isSunday = today.getDay() === 0;
  const label = isSunday ? 'This week + Next week' : 'This week';
  return `${label} · ${months[s.getMonth()]} ${s.getDate()} – ${months[e.getMonth()]} ${e.getDate()}`;
}

// ── Render ─────────────────────────────────────────────────────
function render() {
  const container = document.getElementById('taskListContainer');
  const empty = document.getElementById('emptyState');
  const { start: wStart, end: wEnd } = getWeekWindow();
  const tk = todayKey();

  // Counts use ALL tasks (not window-filtered) for accuracy
  document.getElementById('remaining').textContent = tasks.filter(t=>!t.done).length;
  document.getElementById('count-all').textContent = tasks.filter(t=>!t.done).length;
  document.getElementById('count-work').textContent = tasks.filter(t=>!t.done&&t.category==='work').length;
  document.getElementById('count-personal').textContent = tasks.filter(t=>!t.done&&t.category==='personal').length;

  const hasWork = tasks.some(t=>t.category==='work');
  

  // Filter by category + status first
  const catFiltered = tasks.filter(t => {
    const catMatch = category==='all'||t.category===category;
    const statusMatch = filter==='all' ? true
      : filter==='active'  ? (!t.done && !t.blocked)
      : filter==='done'    ? t.done
      : filter==='blocked' ? t.blocked
      : true;
    return catMatch && statusMatch;
  });

  // Apply weekly window:
  // - Overdue tasks (scheduled before today) always show — you need to deal with them
  // - Tasks scheduled within the window show
  // - Unscheduled tasks always show
  // - Tasks scheduled AFTER the window are hidden (next week+ unless it's Sunday)
  const visible = catFiltered.filter(t => {
    const sd = t.scheduledDate;
    if (!sd) return true;                    // unscheduled always visible
    if (sd < tk) return true;               // overdue always visible
    return sd >= wStart && sd <= wEnd;      // within this week's window
  });

  const hasDone = catFiltered.some(t=>t.done);
  document.getElementById('clearBtn').style.display = hasDone?'inline-block':'none';

  // Apply sort
  const priorityOrder = { high:0, medium:1, low:2, detecting:3 };
  if (sortMode === 'priority') {
    visible.sort((a,b) => (priorityOrder[a.priority]??2) - (priorityOrder[b.priority]??2));
  } else if (sortMode === 'date') {
    visible.sort((a,b) => {
      if (!a.scheduledDate && !b.scheduledDate) return 0;
      if (!a.scheduledDate) return 1;
      if (!b.scheduledDate) return -1;
      return a.scheduledDate.localeCompare(b.scheduledDate);
    });
  }

  // Count hidden future tasks (scheduled beyond window, not done)
  const hiddenCount = catFiltered.filter(t => {
    const sd = t.scheduledDate;
    return sd && sd > wEnd && !t.done;
  }).length;

  // Build week banner
  const isSunday = new Date().getDay() === 0;
  const bannerColor = isSunday ? 'rgba(124,156,255,.12)' : 'rgba(200,241,53,.06)';
  const bannerBorder = isSunday ? 'rgba(124,156,255,.25)' : 'rgba(200,241,53,.15)';
  const bannerTextColor = isSunday ? 'var(--work)' : 'var(--accent)';
  let weekBanner = `<div style="font-family:'Space Mono',monospace;font-size:10px;color:${bannerTextColor};background:${bannerColor};border:1px solid ${bannerBorder};border-radius:8px;padding:8px 12px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
    <span>${getWeekLabel()}</span>
    <div style="display:flex;align-items:center;gap:8px;">
      ${hiddenCount > 0 ? `<span style="color:var(--muted)">${hiddenCount} task${hiddenCount>1?'s':''} next week</span>` : ''}
      <button onclick="toggleReport(event)" style="background:none;border:1px solid ${bannerBorder};color:${bannerTextColor};font-family:'Space Mono',monospace;font-size:9px;padding:4px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;min-height:26px;">📋 Report</button>
    </div>
  </div>`;

  if (visible.length === 0) {
    container.innerHTML = weekBanner;
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  // Group into buckets
  const overdue = [], today = [], tomorrow = [], future = new Map(), unscheduled = [];
  const tmk = tomorrowKey();

  for (const t of visible) {
    const sd = t.scheduledDate;
    if (!sd) { unscheduled.push(t); continue; }
    if (sd < tk) { overdue.push(t); continue; }
    if (sd === tk) { today.push(t); continue; }
    if (sd === tmk) { tomorrow.push(t); continue; }
    if (!future.has(sd)) future.set(sd, []);
    future.get(sd).push(t);
  }

  const sortedFuture = [...future.entries()].sort((a,b)=>a[0].localeCompare(b[0]));

  let html = weekBanner;

  function renderGroup(label, items, labelClass='', isOverdueGroup=false) {
    if (!items.length) return;
    html += `<div class="day-group">
      <div class="day-group-header">
        <span class="day-group-label ${labelClass}">${label}</span>
        <div class="day-group-line"></div>
        <span class="day-group-count">${items.length}</span>
      </div>
      <div class="task-list">${items.map(t=>renderTask(t, isOverdueGroup)).join('')}</div>
    </div>`;
  }

  renderGroup('⚠ Overdue', overdue, 'overdue', true);
  renderGroup('Today', today, 'today');
  renderGroup('Tomorrow', tomorrow, 'tomorrow');
  for (const [key, items] of sortedFuture) renderGroup(formatDateKey(key), items);
  renderGroup('Unscheduled', unscheduled);

  container.innerHTML = html;
  initDrag(); // attach touch drag to handles
}

function renderTask(t, isOverdue=false) {
  const p = t.priority, cat = t.category||'work';
  const priorityHtml = p && p!=='detecting' ? `<span class="priority-badge ${p}">${p}</span>` : p==='detecting'?`<span class="priority-badge detecting">...</span>`:'';
  const tagBadge = t.tag ? `<span class="task-tag-badge">#${escapeHtml(t.tag)}</span>` : '';
  const noteClass = cat==='work'?(t.notes?' has-notes':' no-notes-work'):(t.notes?' has-notes':'');
  const stateClass = t.done ? 'done' : t.blocked ? 'blocked' : '';
  const overdueClass = isOverdue && !t.blocked ? ' overdue-item' : '';
  const blockedBadge = t.blocked ? `<span class="blocked-badge">BLOCKED</span>` : '';
  return `<div class="task-item ${stateClass} cat-${cat}${overdueClass}" draggable="true" data-id="${t.id}"
      ondragstart="dragStart(event,${t.id})" ondragover="dragOver(event)" ondrop="dragDrop(event,${t.id})" ondragend="dragEnd(event)"
      onclick="handleTaskTap(event,${t.id})">
    <div class="checkbox" onclick="event.stopPropagation();toggleTask(${t.id})">
      <div class="checkbox-inner">
        <span class="icon-check"><svg width="11" height="9" viewBox="0 0 12 10" fill="none"><path d="M1 5L4.5 8.5L11 1.5" stroke="#0d0d0d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="icon-block">✕</span>
      </div>
    </div>
    <div class="task-body">
      <div class="task-text${noteClass}">${escapeHtml(t.text)}</div>
      <div class="task-meta">
        <span class="cat-badge ${cat}">${cat}</span>
        ${blockedBadge}
        ${tagBadge}
        ${priorityHtml}
        <div class="timestamps">
          <div class="timestamp"><span class="ts-label">Added</span><span class="ts-value">${formatTime(t.createdAt||t.id)}</span></div>
          ${t.done&&t.completedAt?`<div class="timestamp ts-done"><span class="ts-label">Done</span><span class="ts-value">${formatTime(t.completedAt)}</span></div>`:''}
        </div>
      </div>
    </div>
    <button class="task-menu-btn" aria-label="More actions" onclick="event.stopPropagation();openTaskMenu(${t.id})">⋯</button>
  </div>`;
}

// ── Confirm delete ─────────────────────────────────────────────
let pendingDeleteId = null;
function askDelete(id) {
  const t = tasks.find(t=>t.id===id); if (!t) return;
  pendingDeleteId = id;
  document.getElementById('confirmTaskText').textContent = t.text;
  document.getElementById('confirmOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('open');
  document.body.style.overflow = '';
  pendingDeleteId = null;
}
function confirmDelete() {
  if (!pendingDeleteId) return;
  tasks = tasks.filter(t=>t.id!==pendingDeleteId);
  setTombstone(pendingDeleteId, Date.now());
  save(); render(); pushIfConnected('delete-task'); closeConfirm();
}

// ── Drag to reorder ────────────────────────────────────────────
let dragId = null;
// ── Drag to reorder (touch + mouse) ───────────────────────────
let touchDragEl = null;
let touchDragId = null;
let touchStartY = 0;
let touchGesture = null;
let ignoreTaskTapUntil = 0;

let longPressTimer = null;
const LONG_PRESS_MS = 500;

function initDrag() {
  document.querySelectorAll('.task-item').forEach(item => {
    item.addEventListener('touchstart', onItemTouchStart, { passive: true });
    item.addEventListener('touchend', onItemTouchEndLocal);
    item.addEventListener('touchcancel', onItemTouchCancel);
    item.addEventListener('touchmove', onItemTouchMoveLocal, { passive: false });
  });
}

function onItemTouchStart(e) {
  const item = e.target.closest('.task-item');
  if (!item) return;
  if (e.target.closest('.checkbox') || e.target.closest('.task-menu-btn')) return;
  const touch = e.touches[0];
  touchGesture = { item, id: parseInt(item.dataset.id, 10), startX: touch.clientX, startY: touch.clientY, dx: 0, dy: 0, swiping: false };
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    if (touchGesture && !touchGesture.swiping) startTouchDrag(e, item);
  }, LONG_PRESS_MS);
}

function onItemTouchMoveLocal(e) {
  if (touchDragEl) return;
  if (!touchGesture) return;
  const touch = e.touches[0];
  touchGesture.dx = touch.clientX - touchGesture.startX;
  touchGesture.dy = touch.clientY - touchGesture.startY;
  if (!touchGesture.swiping) {
    if (Math.abs(touchGesture.dx) > 14 && Math.abs(touchGesture.dx) > Math.abs(touchGesture.dy) + 6) {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      touchGesture.swiping = true;
    } else if (Math.abs(touchGesture.dx) > 8 || Math.abs(touchGesture.dy) > 8) {
      onItemTouchCancel();
      return;
    }
  }
  if (touchGesture.swiping) {
    e.preventDefault();
    applyTaskSwipe(touchGesture.item, touchGesture.dx);
  }
}

function onItemTouchEndLocal() {
  if (touchGesture && touchGesture.swiping) {
    const { item, id, dx } = touchGesture;
    ignoreTaskTapUntil = Date.now() + 420;
    resetTaskSwipe(item);
    if (dx > 72) {
      quickCompleteSwipe(id);
    } else if (dx < -72) {
      askDelete(id);
    }
    touchGesture = null;
    return;
  }
  onItemTouchCancel();
}

function onItemTouchCancel() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  if (touchGesture && touchGesture.item) resetTaskSwipe(touchGesture.item);
  touchGesture = null;
}

function applyTaskSwipe(item, dx) {
  const clamped = Math.max(-88, Math.min(88, dx));
  item.style.transform = `translateX(${clamped}px)`;
  item.classList.toggle('swipe-right', clamped > 16);
  item.classList.toggle('swipe-left', clamped < -16);
}

function resetTaskSwipe(item) {
  if (!item) return;
  item.style.transform = '';
  item.classList.remove('swipe-right', 'swipe-left');
}

function handleTaskTap(event, id) {
  if (Date.now() < ignoreTaskTapUntil) return;
  if (event.target.closest('.checkbox') || event.target.closest('.task-menu-btn')) return;
  openModal(id);
}

function quickCompleteSwipe(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  if (t.blocked) {
    showSyncIndicator('Blocked tasks need to be unblocked first');
    return;
  }
  t.done = !t.done;
  if (t.done) {
    t.completedAt = Date.now();
    t.blocked = false;
  } else {
    t.completedAt = null;
  }
  t.updatedAt = Date.now();
  save();
  render();
  pushIfConnected('swipe-complete');
  if (navigator.vibrate) navigator.vibrate(18);
  if (t.done) {
    checkAllDone();
    maybeAutoArchiveTask(t.id);
  }
}

function startTouchDrag(e, item) {
  touchDragId = parseInt(item.dataset.id);
  touchDragEl = item;
  touchStartY = e.touches[0].clientY;
  item.classList.add('dragging');
  if (navigator.vibrate) navigator.vibrate(30);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd);
}

function onTouchMove(e) {
  e.preventDefault();
  if (!touchDragEl) return;
  const y = e.touches[0].clientY;
  const items = [...document.querySelectorAll('.task-item:not(.dragging)')];
  document.querySelectorAll('.task-item.drag-over').forEach(x => x.classList.remove('drag-over'));
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (y < mid) { item.classList.add('drag-over'); break; }
  }
}

function onTouchEnd(e) {
  document.removeEventListener('touchmove', onTouchMove);
  document.removeEventListener('touchend', onTouchEnd);
  if (!touchDragEl) return;

  const overEl = document.querySelector('.task-item.drag-over');
  if (overEl && overEl.dataset.id) {
    const targetId = parseInt(overEl.dataset.id);
    if (targetId !== touchDragId) {
      const fromIdx = tasks.findIndex(t => t.id === touchDragId);
      const toIdx = tasks.findIndex(t => t.id === targetId);
      if (fromIdx >= 0 && toIdx >= 0) {
        const [moved] = tasks.splice(fromIdx, 1);
        tasks.splice(toIdx, 0, moved);
        save();
      }
    }
  }

  document.querySelectorAll('.task-item').forEach(x => x.classList.remove('dragging', 'drag-over'));
  touchDragEl = null; touchDragId = null;
  tasks.forEach((t, i) => t.sortOrder = i);
  save();
  render();
  pushIfConnected('touch-reorder');
}

// Desktop drag (mouse)
function dragStart(e, id) {
  dragId = id;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => { const el = e.target.closest('.task-item'); if (el) el.classList.add('dragging'); }, 0);
}
function dragOver(e) {
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  const el = e.target.closest('.task-item');
  document.querySelectorAll('.task-item.drag-over').forEach(x => x.classList.remove('drag-over'));
  if (el && el.dataset.id != dragId) el.classList.add('drag-over');
}
function dragDrop(e, targetId) {
  e.preventDefault();
  document.querySelectorAll('.task-item.drag-over').forEach(x => x.classList.remove('drag-over'));
  if (!dragId || dragId === targetId) return;
  const fromIdx = tasks.findIndex(t => t.id === dragId);
  const toIdx = tasks.findIndex(t => t.id === targetId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = tasks.splice(fromIdx, 1);
  tasks.splice(toIdx, 0, moved);
  tasks.forEach((t, i) => t.sortOrder = i);
  save(); render();
  pushIfConnected('reorder');
}
function dragEnd(e) {
  dragId = null;
  document.querySelectorAll('.task-item').forEach(x => x.classList.remove('dragging', 'drag-over'));
}

// ── Status dropdown ────────────────────────────────────────────
let sortMode = 'default';

function setFilterFromSelect(val) {
  filter = val; render();
}

function setSortFromSelect(val) {
  sortMode = val; render();
}

// ── Sync settings UI ──────────────────────────────────────────
async function renderSyncSettings() {
  const row = document.getElementById('syncSettingsRow');
  if (!row) return;
  refreshLastSyncUI();
  archiveData = await loadArchive().catch(() => getLocalArchiveCache());
  renderCalendar();
  if ((isTokenValid() || gUserId) && sheetId) {
    const label = gUserId ? `Synced · ${gUserId}` : 'Synced';
    row.innerHTML = `<div class="sync-status"><div class="sync-dot on"></div><span>${label}</span></div><button class="btn-sm" onclick="syncNow()">Sync now</button><button class="btn-signout" onclick="googleSignOut()">Sign out</button>`;
  } else {
    row.innerHTML = `<div class="sync-status"><div class="sync-dot"></div><span>Not signed in</span></div>
    <button class="google-btn" onclick="googleSignIn()">
      <svg width="14" height="14" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/><path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/></svg>
      Sign in
    </button>`;
  }
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts), days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return `${days[d.getDay()]}, ${d.toLocaleDateString('en-US',{month:'short',day:'numeric'})} · ${d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}`;
}

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function getTombstones() {
  try { return JSON.parse(localStorage.getItem('wtt_tombstones') || '{}'); } catch (_) { return {}; }
}

function setTombstone(id, ts = Date.now()) {
  const data = getTombstones();
  data[String(id)] = ts;
  const entries = Object.entries(data).sort((a,b) => b[1] - a[1]).slice(0, 500);
  localStorage.setItem('wtt_tombstones', JSON.stringify(Object.fromEntries(entries)));
}

function clearTombstonesForActiveTasks() {
  const data = getTombstones();
  let changed = false;
  for (const t of tasks) {
    if (data[String(t.id)]) { delete data[String(t.id)]; changed = true; }
  }
  if (changed) localStorage.setItem('wtt_tombstones', JSON.stringify(data));
}

function refreshLastSyncUI() {
  const el = document.getElementById('lastSyncText');
  if (!el) return;
  const ts = parseInt(localStorage.getItem('wtt_last_synced_at') || '0');
  el.textContent = ts
    ? `Last synced: ${new Date(ts).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}`
    : 'Last synced: not yet';
}

async function setLastSynced(ts, source = 'sync') {
  localStorage.setItem('wtt_last_synced_at', String(ts || Date.now()));
  localStorage.setItem('wtt_last_sync_source', source);
  refreshLastSyncUI();
  archiveData = await loadArchive().catch(() => getLocalArchiveCache());
  renderCalendar();
}

function announceSync(reason = 'sync') {
  const payload = JSON.stringify({ at: Date.now(), reason });
  localStorage.setItem('wtt_sync_ping', payload);
  try { syncChannel?.postMessage({ type: 'SYNC_PING', reason, at: Date.now() }); } catch (_) {}
}

function schedulePeriodicSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshFromSource('interval').catch(() => {});
  }, SYNC_POLL_MS);
}

// ── Google Sheets Sync ────────────────────────────────────────
// SETUP: Replace with your OAuth Client ID from Google Cloud Console
// Guide: See SETUP.md included in this zip
const GOOGLE_CLIENT_ID = '515252740980-j0v2em58m97e9put88p550o1kdlo492p.apps.googleusercontent.com';
const SHEET_NAME = 'Weekly Tracker Task Database';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive';
const PROXY = 'https://wtt-proxy.onrender.com';

let gAccessToken = localStorage.getItem('wtt_gtoken') || null;
let gTokenExpiry = parseInt(localStorage.getItem('wtt_gexpiry') || '0');
let gUserId = localStorage.getItem('wtt_userid') || null;
let sheetId = localStorage.getItem('wtt_sheetid') || null;
let isSyncing = false;
let syncDebounceTimer = null;
let isPushing = false; // true while pushAllTasksToSheet is running

function isTokenValid() {
  return gAccessToken && Date.now() < gTokenExpiry - 60000;
}

async function getValidToken() {
  if (isTokenValid()) return true;
  // Silent refresh via Google
  return new Promise((resolve) => {
    if (typeof google === 'undefined' || !google.accounts) { resolve(false); return; }
    try {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPES,
        prompt: '',
        hint: gUserId || '',
        callback: (resp) => {
          if (resp.error) { resolve(false); return; }
          gAccessToken = resp.access_token;
          gTokenExpiry = Date.now() + (resp.expires_in * 1000);
          localStorage.setItem('wtt_gtoken', gAccessToken);
          localStorage.setItem('wtt_gexpiry', String(gTokenExpiry));
          resolve(true);
        }
      });
      client.requestAccessToken({ prompt: '' });
    } catch(e) { resolve(false); }
  });
}

function googleSignIn() {
  if (typeof google === 'undefined' || !google.accounts) {
    const row = document.getElementById('syncSettingsRow');
    if (row) row.innerHTML = `<div class="sync-status"><div class="sync-dot syncing"></div><span>Loading...</span></div>`;
    setTimeout(googleSignIn, 1000);
    return;
  }
  try {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES + ' email profile',
      callback: async (resp) => {
        if (resp.error) { console.error('Auth error:', resp); renderSyncSettings(); return; }
        gAccessToken = resp.access_token;
        gTokenExpiry = Date.now() + (resp.expires_in * 1000);
        localStorage.setItem('wtt_gtoken', gAccessToken);
        localStorage.setItem('wtt_gexpiry', String(gTokenExpiry));
        // Get user email for hint on future silent refreshes
        try {
          const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { 'Authorization': `Bearer ${gAccessToken}` }
          });
          const userInfo = await userRes.json();
          gUserId = userInfo.email || null;
          if (gUserId) localStorage.setItem('wtt_userid', gUserId);
        } catch(e) {}
        updateSyncUI('syncing', '');
        renderSyncSettings();
        await initSheet();
      }
    });
    client.requestAccessToken();
  } catch(e) {
    console.error('Sign in error:', e);
    renderSyncSettings();
  }
}

function googleSignOut() {
  gAccessToken = null; gTokenExpiry = 0; gUserId = null; sheetId = null;
  localStorage.removeItem('wtt_gtoken');
  localStorage.removeItem('wtt_gexpiry');
  localStorage.removeItem('wtt_userid');
  localStorage.removeItem('wtt_sheetid');
  updateSyncUI('off', '');
  renderSyncSettings();
}

async function sheetsRequest(method, path, body) {
  // Ensure we have a valid token — refresh silently if expired
  const valid = isTokenValid() || await getValidToken();
  if (!valid) { googleSignOut(); return null; }
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${gAccessToken}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    // Token rejected — try refresh once
    const refreshed = await getValidToken();
    if (!refreshed) { googleSignOut(); return null; }
    const retry = await fetch(`https://sheets.googleapis.com/v4/spreadsheets${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${gAccessToken}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: body ? JSON.stringify(body) : undefined
    });
    if (!retry.ok) return null;
    return retry.json();
  }
  if (!res.ok) {
    const err = await res.text();
    console.error('Sheets API error:', res.status, err);
    return null;
  }
  return res.json();
}

async function driveRequest(method, path, body) {
  if (!isTokenValid()) return null;
  const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${gAccessToken}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) return null;
  // DELETE returns 204 No Content — don't try to parse JSON
  if (res.status === 204 || method === 'DELETE') return true;
  return res.json();
}


async function initSheet() {
  // Search ALL matching sheets sorted by most recently modified
  const search = await driveRequest('GET',
    `/files?q=name='${SHEET_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`
  );

  const files = search?.files || [];

  if (files.length === 0) {
    // No sheet exists — create one
    const created = await sheetsRequest('POST', '', {
      properties: { title: SHEET_NAME },
      sheets: [{ properties: { title: 'Tasks' } }]
    });
    if (!created) return;
    sheetId = created.spreadsheetId;
    localStorage.setItem('wtt_sheetid', sheetId);
    await sheetsRequest('PUT', `/${sheetId}/values/Tasks!A1:M1?valueInputOption=RAW`, {
      values: [['id','text','category','done','blocked','priority','scheduledDate','notes','createdAt','completedAt','updatedAt','tag','sortOrder']]
    });
    await pushAllTasksToSheet();

  } else if (files.length === 1) {
    // Exactly one sheet — use it
    sheetId = files[0].id;
    localStorage.setItem('wtt_sheetid', sheetId);
    await mergeWithSheet();

  } else {
    // Multiple sheets — find the one with the most tasks (most data = real one)
    let bestId = files[0].id;
    let bestCount = -1;

    for (const file of files) {
      const data = await sheetsRequest('GET', `/${file.id}/values/Tasks!A2:A?majorDimension=ROWS`);
      const count = data?.values?.length || 0;
      if (count > bestCount) {
        bestCount = count;
        bestId = file.id;
      }
    }

    const duplicateCount = Math.max(files.length - 1, 0);
    if (duplicateCount > 0) {
      showSyncIndicator(`Using the fullest sheet (${duplicateCount} duplicate${duplicateCount !== 1 ? 's' : ''} left untouched)`);
    }

    sheetId = bestId;
    localStorage.setItem('wtt_sheetid', sheetId);
    await mergeWithSheet();
  }

  updateSyncUI('on', '');
  renderSyncSettings();
  showSyncIndicator('✓ Connected');
}

async function mergeWithSheet() {
  if (isPushing) return;
  updateSyncUI('syncing', 'Syncing...');
  const data = await sheetsRequest('GET', `/${sheetId}/values/Tasks!A2:M?majorDimension=ROWS`);
  const rows = data?.values || [];
  const tombstones = getTombstones();

  const sheetTasks = rows.filter(r => r[0]).map(r => ({
    id: parseInt(r[0]) || Date.now(),
    text: r[1] || '',
    category: r[2] || 'work',
    done: r[3] === 'true',
    blocked: r[4] === 'true',
    priority: r[5] || 'medium',
    scheduledDate: r[6] || null,
    notes: r[7] || '',
    createdAt: parseInt(r[8]) || Date.now(),
    completedAt: r[9] ? parseInt(r[9]) : null,
    updatedAt: parseInt(r[10]) || parseInt(r[8]) || 0,
    tag: r[11] || null,
    sortOrder: parseInt(r[12]) || parseInt(r[8]) || 0
  })).filter(t => !(tombstones[String(t.id)] && tombstones[String(t.id)] >= (t.updatedAt || 0)));

  const localTasks = tasks.map(t => ({ ...t, updatedAt: t.updatedAt || t.createdAt || 0 }));
  const finalMap = new Map();

  for (const t of sheetTasks) finalMap.set(t.id, t);
  for (const localTask of localTasks) {
    const current = finalMap.get(localTask.id);
    if (!current || (localTask.updatedAt || 0) > (current.updatedAt || 0)) {
      finalMap.set(localTask.id, localTask);
    }
  }

  tasks = [...finalMap.values()].sort((a,b) => {
    if (a.sortOrder !== undefined && b.sortOrder !== undefined) return a.sortOrder - b.sortOrder;
    return b.createdAt - a.createdAt;
  });

  localStorage.setItem('wtt_tasks', JSON.stringify(tasks));
  clearTombstonesForActiveTasks();
  render();

  if (activeTaskId) {
    const t = tasks.find(t => t.id === activeTaskId);
    if (t) {
      const tagInputEl = document.getElementById('tagInput');
      if (tagInputEl && t.tag && !tagInputEl.value.trim()) tagInputEl.value = t.tag;
    }
  }
}

async function pushAllTasksToSheet() {
  if (!sheetId || !isTokenValid()) return false;
  isPushing = true;
  try {
    await sheetsRequest('POST', `/${sheetId}/values/Tasks!A2:M:clear`, {});
    if (tasks.length === 0) return true;
    const rows = tasks.map(t => [
      t.id, t.text, t.category||'work',
      t.done?'true':'false', t.blocked?'true':'false',
      t.priority||'medium', t.scheduledDate||'',
      t.notes||'', t.createdAt||'', t.completedAt||'',
      t.updatedAt || t.createdAt || Date.now(),
      t.tag||'',
      t.sortOrder ?? t.createdAt
    ]);
    await sheetsRequest('PUT', `/${sheetId}/values/Tasks!A2:M?valueInputOption=RAW`, { values: rows });
    return true;
  } finally {
    isPushing = false;
  }
}

async function refreshFromSource(reason = 'manual') {
  if (!sheetId || !(isTokenValid() || gUserId)) { refreshLastSyncUI(); return false; }
  const valid = isTokenValid() || await getValidToken();
  if (!valid) return false;
  await mergeWithSheet();
  setLastSynced(Date.now(), reason);
  renderSyncSettings();
  archiveData = await loadArchive();
  if (archiveOpen) renderArchive(archiveData);
  renderCalendar();
  return true;
}

async function runFullSync(reason = 'manual', options = {}) {
  if (!sheetId || !(isTokenValid() || gUserId)) return false;
  if (syncPromise) return syncPromise;
  const { archiveList = null } = options;
  syncPromise = (async () => {
    const valid = isTokenValid() || await getValidToken();
    if (!valid) return false;
    showSyncIndicator('↻ Syncing...');
    const wrote = await pushAllTasksToSheet();
    if (archiveList && archiveList.length) await archiveTasks(archiveList);
    await mergeWithSheet();
    if (wrote) {
      setLastSynced(Date.now(), reason);
      announceSync(reason);
      showSyncIndicator('✓ Synced');
    }
    renderSyncSettings();
    archiveData = await loadArchive();
    if (archiveOpen) renderArchive(archiveData);
    renderCalendar();
    return wrote;
  })().finally(() => { syncPromise = null; });
  return syncPromise;
}

function scheduleFullSync(reason = 'mutation') {
  if (!sheetId || !isTokenValid()) return;
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => { runFullSync(reason).catch(() => {}); }, 500);
}

function syncNow() {
  runFullSync('manual').catch(() => refreshFromSource('manual').catch(() => {}));
}

function showSyncIndicator(msg) {
  const el = document.getElementById('syncIndicator');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

function updateSyncUI(state, text) {
  // sync status lives inside settings panel now via renderSyncSettings
  // dot/text elements only exist when settings is open — safe to ignore here
}

async function initGoogleSync() {
  renderSyncSettings();
  if (sheetId && (isTokenValid() || gUserId)) {
    const valid = isTokenValid() || await getValidToken();
    if (valid) {
      updateSyncUI('syncing', '');
      await refreshFromSource('startup');
      updateSyncUI('on', '');
      renderSyncSettings();
      showSyncIndicator('✓ Connected');
      startTokenKeepalive();
      schedulePeriodicSync();
    } else {
      renderSyncSettings();
    }
  }
}

// Refresh token every 45 min — token only, no sync
let keepaliveTimer = null;
function startTokenKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = setInterval(async () => {
    if (!isTokenValid()) {
      await getValidToken();
      renderSyncSettings();
    }
  }, 45 * 60 * 1000);
}

function addSignOutButton() { renderSyncSettings(); }

// save() — persists locally only (sheet push happens in saveModal/addTask/background)
function save() {
  tasks = tasks.map(t => ({ ...t, updatedAt: t.updatedAt || t.createdAt }));
  localStorage.setItem('wtt_tasks', JSON.stringify(tasks));
  updateArchiveButton();
}

function updateArchiveButton() {
  const btn = document.getElementById('clearBtn');
  if (!btn) return;
  const count = tasks.filter(t => t.done && !t.blocked && (category === 'all' || t.category === category)).length;
  btn.textContent = `Archive completed (${count})`;
  btn.disabled = count === 0;
  btn.style.opacity = count === 0 ? '.5' : '1';
}

// pushIfConnected — call explicitly when user takes an action
function pushIfConnected(reason = 'mutation') {
  scheduleFullSync(reason);
}

// ── Client ID setup in settings ───────────────────────────────
function saveProxyUrl() {
  const el = document.getElementById('proxyUrlInput');
  if (!el) return;
  const val = el.value.trim().replace(/\/+$/, '');
  if (!val) return;
  localStorage.setItem('wtt_proxy', val);
  el.value = val;
  const btn = document.querySelector('[onclick="saveProxyUrl()"]');
  if (btn) { btn.textContent = '✓ Saved'; setTimeout(() => btn.textContent = 'Save', 1500); }
  initAIStatus();
}




// ── Monthly Calendar ──────────────────────────────────────────
let calOpen = false;
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();

function toggleCalendar() {
  calOpen = !calOpen;
  const overlay = document.getElementById('calOverlay');
  overlay.classList.toggle('open', calOpen);
  document.body.style.overflow = calOpen ? 'hidden' : '';
  if (calOpen) {
    calYear = new Date().getFullYear();
    calMonth = new Date().getMonth();
    renderCalendar();
  }
}

function handleCalOverlayClick(e) {
  if (e.target === document.getElementById('calOverlay')) toggleCalendar();
}

function changeCalMonth(dir) {
  calMonth += dir;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
}

function renderCalendar() {
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  document.getElementById('calTitle').textContent = `${months[calMonth]} ${calYear}`;

  const grid = document.getElementById('calGrid');
  const today = new Date(); today.setHours(0,0,0,0);
  const todayStr = toDateKey(today);

  // First day of month and total days
  const firstDay = new Date(calYear, calMonth, 1);
  const lastDay = new Date(calYear, calMonth + 1, 0);
  const startDow = firstDay.getDay(); // 0=Sun
  const totalDays = lastDay.getDate();

  // Build task data map for this month: dateKey → {done, pending, blocked}
  const taskMap = {};
  const workTasks = tasks.filter(t => t.category === 'work');

  for (const t of workTasks) {
    const key = t.scheduledDate;
    if (key) {
      if (!taskMap[key]) taskMap[key] = { done:0, pending:0, blocked:0 };
      if (t.done) taskMap[key].done++;
      else if (t.blocked) taskMap[key].blocked++;
      else taskMap[key].pending++;
    }
    if (t.done && t.completedAt) {
      const ck = toDateKey(new Date(t.completedAt));
      if (!taskMap[ck]) taskMap[ck] = { done:0, pending:0, blocked:0 };
      if (ck !== t.scheduledDate) taskMap[ck].done++;
    }
  }

  // Merge in archived task counts from localStorage
  const calArchive = JSON.parse(localStorage.getItem('wtt_calarchive') || '{}');
  for (const [dateKey, data] of Object.entries(calArchive)) {
    if (!taskMap[dateKey]) taskMap[dateKey] = { done:0, pending:0, blocked:0 };
    taskMap[dateKey].done += data.done || 0;
  }

  let html = '';

  // Leading empty cells
  for (let i = 0; i < startDow; i++) {
    html += `<div class="cal-day other-month"><span class="cal-day-num"></span></div>`;
  }

  // Day cells
  for (let d = 1; d <= totalDays; d++) {
    const dateObj = new Date(calYear, calMonth, d);
    const key = toDateKey(dateObj);
    const isToday = key === todayStr;
    const data = taskMap[key];
    const total = data ? (data.done + data.pending + data.blocked) : 0;

    let barHtml = '';
    if (total > 0) {
      const donePct = Math.round((data.done / total) * 100);
      barHtml = `<div class="cal-bar-wrap">
        <div class="cal-bar-pending" style="height:${100-donePct}%"></div>
        <div class="cal-bar-done" style="height:${donePct}%"></div>
      </div>`;
    }

    html += `<div class="cal-day${isToday?' today':''}${total>0?' has-tasks':''}">
      <span class="cal-day-num">${d}</span>
      ${barHtml}
    </div>`;
  }

  // Trailing empty cells to complete grid
  const totalCells = startDow + totalDays;
  const trailing = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 0; i < trailing; i++) {
    html += `<div class="cal-day other-month"><span class="cal-day-num"></span></div>`;
  }

  grid.innerHTML = html;
}

// ── Monthly data cleanup ─────────────────────────────────────


function handleArchiveOverlayClick(e) {
  if (e.target === document.getElementById('archiveOverlay')) toggleArchive();
}

// ── Archive ────────────────────────────────────────────────────
const ARCHIVE_TAB = 'Archive';

async function ensureArchiveTab() {
  if (!sheetId || !isTokenValid()) return false;
  // Check if Archive tab exists
  const meta = await sheetsRequest('GET', `/${sheetId}?fields=sheets.properties.title`);
  const exists = meta?.sheets?.some(s => s.properties.title === ARCHIVE_TAB);
  if (!exists) {
    // Create Archive tab
    await sheetsRequest('POST', `/${sheetId}:batchUpdate`, {
      requests: [{ addSheet: { properties: { title: ARCHIVE_TAB } } }]
    });
    // Add headers
    await sheetsRequest('PUT', `/${sheetId}/values/${ARCHIVE_TAB}!A1:O1?valueInputOption=RAW`, {
      values: [['id','text','category','done','blocked','priority','scheduledDate','notes','createdAt','completedAt','updatedAt','tag','sortOrder','archivedAt','archivedDate']]
    });
  }
  return true;
}

function getLocalArchiveCache() {
  return JSON.parse(localStorage.getItem('wtt_archivecache') || '[]');
}

function setLocalArchiveCache(items) {
  localStorage.setItem('wtt_archivecache', JSON.stringify(items));
}

function syncCalendarArchiveCache(items) {
  const calData = {};
  for (const t of items) {
    if (t.category !== 'work') continue;
    const dateKey = t.archivedDate || (t.archivedAt ? toDateKey(new Date(t.archivedAt)) : null);
    if (!dateKey) continue;
    if (!calData[dateKey]) calData[dateKey] = { done: 0 };
    calData[dateKey].done += 1;
  }
  localStorage.setItem('wtt_calarchive', JSON.stringify(calData));
  return calData;
}

function archiveEntryToRow(t) {
  return [
    t.id, t.text, t.category||'work',
    t.done?'true':'false', t.blocked?'true':'false',
    t.priority||'medium', t.scheduledDate||'',
    t.notes||'', t.createdAt||'', t.completedAt||'',
    t.updatedAt||'', t.tag||'', t.sortOrder||'',
    t.archivedAt||'', t.archivedDate||''
  ];
}

async function rewriteArchiveSheet(items) {
  if (!sheetId || !isTokenValid()) return false;
  const ok = await ensureArchiveTab();
  if (!ok) return false;
  await sheetsRequest('POST', `/${sheetId}/values/${ARCHIVE_TAB}!A2:O:clear`, {});
  if (items.length) {
    await sheetsRequest('PUT', `/${sheetId}/values/${ARCHIVE_TAB}!A2:O?valueInputOption=RAW`, {
      values: items.map(archiveEntryToRow)
    });
  }
  return true;
}

async function archiveTasks(taskList) {
  if (!taskList.length) return;

  const now = Date.now();
  const nowDate = toDateKey(new Date());
  const archiveEntries = taskList.map(t => ({
    ...t,
    done: true,
    archivedAt: now,
    archivedDate: nowDate
  }));

  const existing = getLocalArchiveCache();
  const deduped = [...archiveEntries, ...existing.filter(old => !archiveEntries.some(entry => entry.id === old.id))]
    .sort((a,b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  setLocalArchiveCache(deduped);
  syncCalendarArchiveCache(deduped);

  if (!sheetId || !isTokenValid()) {
    showSyncIndicator(`✓ ${taskList.length} task${taskList.length!==1?'s':''} archived locally`);
    return;
  }
  const ok = await ensureArchiveTab();
  if (!ok) return;
  const rows = archiveEntries.map(t => [
    t.id, t.text, t.category||'work',
    t.done?'true':'false', t.blocked?'true':'false',
    t.priority||'medium', t.scheduledDate||'',
    t.notes||'', t.createdAt||'', t.completedAt||'',
    t.updatedAt||'', t.tag||'', t.sortOrder||'',
    now, nowDate
  ]);
  await sheetsRequest('POST', `/${sheetId}/values/${ARCHIVE_TAB}!A:O:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    values: rows
  });
  showSyncIndicator(`✓ ${taskList.length} task${taskList.length!==1?'s':''} archived`);
}

async function loadArchive() {
  const fallback = getLocalArchiveCache();
  if (!sheetId || !isTokenValid()) return fallback;
  const ok = await ensureArchiveTab();
  if (!ok) return fallback;
  const data = await sheetsRequest('GET', `/${sheetId}/values/${ARCHIVE_TAB}!A2:O?majorDimension=ROWS`);
  const rows = data?.values || [];
  const result = rows.map((r, idx) => ({
    _rowIndex: idx + 2,
    _archiveKey: `${r[0] || 'x'}:${r[13] || '0'}:${idx + 2}`,
    id: parseInt(r[0]) || Date.now() + idx,
    text: r[1] || '',
    category: r[2] || 'work',
    done: true,
    blocked: r[4] === 'true',
    priority: r[5] || 'medium',
    scheduledDate: r[6] || null,
    notes: r[7] || '',
    createdAt: parseInt(r[8]) || 0,
    completedAt: r[9] ? parseInt(r[9]) : null,
    updatedAt: r[10] ? parseInt(r[10]) : null,
    tag: r[11] || null,
    sortOrder: parseInt(r[12]) || 0,
    archivedAt: parseInt(r[13]) || 0,
    archivedDate: r[14] || ''
  })).filter(t => t.text || t.id).sort((a,b) => b.archivedAt - a.archivedAt);
  setLocalArchiveCache(result);
  syncCalendarArchiveCache(result);
  return result.length ? result : fallback;
}

async function restoreArchivedTask(archiveKey) {
  const cached = getLocalArchiveCache();
  const task = cached.find(t => (t._archiveKey || String(t.id)) === String(archiveKey));
  if (!task) return;
  tasks.unshift({
    id: task.id || Date.now(),
    text: task.text,
    done: false,
    blocked: false,
    category: task.category || 'work',
    createdAt: task.createdAt || Date.now(),
    completedAt: null,
    scheduledDate: task.scheduledDate || null,
    priority: task.priority || 'medium',
    notes: task.notes || '',
    tag: task.tag || null,
    updatedAt: Date.now(),
    sortOrder: task.sortOrder || Date.now()
  });
  const remaining = cached.filter(t => (t._archiveKey || String(t.id)) !== String(archiveKey));
  setLocalArchiveCache(remaining);
  syncCalendarArchiveCache(remaining);
  archiveData = archiveData.filter(t => (t._archiveKey || String(t.id)) !== String(archiveKey));
  save();
  render();
  renderArchive(archiveData);
  if (sheetId && isTokenValid()) {
    try { await rewriteArchiveSheet(remaining); } catch (_) {}
  }
  pushIfConnected('restore-archive');
  showSyncIndicator('✓ Restored from archive');
}

async function deleteArchivedTask(archiveKey) {
  const cached = getLocalArchiveCache();
  const remaining = cached.filter(t => (t._archiveKey || String(t.id)) !== String(archiveKey));
  if (remaining.length === cached.length) return;
  setLocalArchiveCache(remaining);
  syncCalendarArchiveCache(remaining);
  archiveData = archiveData.filter(t => (t._archiveKey || String(t.id)) !== String(archiveKey));
  render();
  renderArchive(archiveData);
  if (sheetId && isTokenValid()) {
    try { await rewriteArchiveSheet(remaining); } catch (_) {}
  }
  showSyncIndicator('✓ Removed from archive');
}

async function editArchivedTaskDate(archiveKey) {
  const cached = getLocalArchiveCache();
  const match = cached.find(t => (t._archiveKey || String(t.id)) === String(archiveKey));
  if (!match) return;
  const initial = match.archivedDate || toDateKey(new Date(match.archivedAt || Date.now()));
  const nextDate = window.prompt('Edit archive date (YYYY-MM-DD)', initial);
  if (nextDate == null) return;
  const trimmed = nextDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    alert('Please enter the date as YYYY-MM-DD.');
    return;
  }
  const parsed = new Date(trimmed + 'T12:00:00');
  if (Number.isNaN(parsed.getTime())) {
    alert('That date is not valid.');
    return;
  }
  const updated = cached.map(t => {
    if ((t._archiveKey || String(t.id)) !== String(archiveKey)) return t;
    return { ...t, archivedDate: trimmed, archivedAt: parsed.getTime() };
  }).sort((a,b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  setLocalArchiveCache(updated);
  syncCalendarArchiveCache(updated);
  archiveData = archiveData.map(t => {
    if ((t._archiveKey || String(t.id)) !== String(archiveKey)) return t;
    return { ...t, archivedDate: trimmed, archivedAt: parsed.getTime() };
  }).sort((a,b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  render();
  renderArchive(archiveData);
  if (sheetId && isTokenValid()) {
    try { await rewriteArchiveSheet(updated); } catch (_) {}
  }
  showSyncIndicator('✓ Archive date updated');
}

// ── Archive View ──────────────────────────────────────────────
let archiveOpen = false;
let archiveData = [];

async function toggleArchive() {
  closeActionMenu();
  archiveOpen = !archiveOpen;
  const overlay = document.getElementById('archiveOverlay');
  overlay.classList.toggle('open', archiveOpen);
  document.body.style.overflow = archiveOpen ? 'hidden' : '';
  if (archiveOpen) {
    document.getElementById('archiveSearch').value = '';
    document.getElementById('archiveBody').innerHTML = '<div class="report-generating">Loading archive...</div>';
    archiveData = await loadArchive();
    renderArchive(archiveData);
  }
}

function renderArchive(data) {
  const body = document.getElementById('archiveBody');
  const search = document.getElementById('archiveSearch').value.toLowerCase();
  const filtered = search ? data.filter(t =>
    t.text.toLowerCase().includes(search) ||
    (t.notes||'').toLowerCase().includes(search) ||
    (t.tag||'').toLowerCase().includes(search)
  ) : data;

  const note = document.getElementById('archiveNote');
  if (note) note.textContent = sheetId && isTokenValid()
    ? 'Archived tasks are synced to Google Sheets and cached locally for quick access.'
    : 'Showing your local archive cache. Connect Google Sync to back it up to Sheets.';

  if (filtered.length === 0) {
    body.innerHTML = `<div class="report-generating">${search ? 'No results.' : 'No archived tasks yet.'}</div>`;
    return;
  }

  // Group by archivedDate
  const groups = new Map();
  for (const t of filtered) {
    const key = t.archivedDate || 'Unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  let html = '';
  for (const [date, items] of groups) {
    const d = new Date(date + 'T00:00:00');
    const label = isNaN(d) ? date : d.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric', year:'numeric' });
    html += `<div class="archive-group">
      <div class="archive-date-label">${label} <span class="archive-count">${items.length}</span></div>
      ${items.map(t => {
        const archiveKey = String(t._archiveKey || t.id).replace(/'/g, "\'");
        return `<div class="archive-item">
        <div class="archive-item-row">
          <div style="flex:1;min-width:0">
            <div class="archive-item-header">
              <div class="archive-item-text">${escapeHtml(t.text)}</div>
              <button class="archive-menu-btn" aria-label="Archive actions" onclick="openArchiveMenu('${archiveKey}')">⋯</button>
            </div>
            <div class="task-meta">
              <span class="cat-badge ${t.category}">${t.category}</span>
              ${t.blocked ? `<span class="archive-blocked-badge">BLOCKED</span>` : ''}
              ${t.tag ? `<span class="task-tag-badge">#${escapeHtml(t.tag)}</span>` : ''}
              ${t.notes ? `<span class="archive-notes">${escapeHtml(t.notes)}</span>` : ''}
            </div>
          </div>
        </div>
      </div>`;
      }).join('')}
    </div>`;
  }
  body.innerHTML = html;
}

// ── Tag autocomplete ──────────────────────────────────────────
let tagHighlightIndex = -1;

function getExistingTags() {
  // Collect all unique tags used across tasks, with usage count
  const tagCount = new Map();
  for (const t of tasks) {
    if (t.tag) {
      tagCount.set(t.tag, (tagCount.get(t.tag) || 0) + 1);
    }
  }
  return [...tagCount.entries()].sort((a,b) => b[1]-a[1]); // sort by usage
}

function onTagInput(val) {
  tagHighlightIndex = -1;
  const dropdown = document.getElementById('tagDropdown');
  if (!dropdown) return;
  const query = val.trim().toLowerCase();
  const allTags = getExistingTags();
  // Filter tags matching query, or show all if empty
  const filtered = query
    ? allTags.filter(([tag]) => tag.includes(query) && tag !== query)
    : allTags;
  if (filtered.length === 0) { dropdown.style.display = 'none'; return; }
  dropdown.innerHTML = filtered.slice(0, 6).map(([tag, count], i) =>
    `<div class="tag-option" data-tag="${tag}" onmousedown="selectTagOption('${tag}')">
      <span class="tag-option-hash">#</span>
      <span>${tag}</span>
      <span class="tag-option-count">${count} task${count!==1?'s':''}</span>
    </div>`
  ).join('');
  dropdown.style.display = 'block';
}

function selectTagOption(tag) {
  const input = document.getElementById('tagInput');
  if (input) input.value = tag;
  closeTagDropdown();
}

function closeTagDropdown() {
  const dropdown = document.getElementById('tagDropdown');
  if (dropdown) dropdown.style.display = 'none';
  tagHighlightIndex = -1;
}

function onTagKeydown(e) {
  const dropdown = document.getElementById('tagDropdown');
  if (!dropdown || dropdown.style.display === 'none') return;
  const options = dropdown.querySelectorAll('.tag-option');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    tagHighlightIndex = Math.min(tagHighlightIndex + 1, options.length - 1);
    options.forEach((o,i) => o.classList.toggle('highlighted', i === tagHighlightIndex));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    tagHighlightIndex = Math.max(tagHighlightIndex - 1, -1);
    options.forEach((o,i) => o.classList.toggle('highlighted', i === tagHighlightIndex));
  } else if (e.key === 'Enter' && tagHighlightIndex >= 0) {
    e.preventDefault();
    const tag = options[tagHighlightIndex]?.dataset.tag;
    if (tag) selectTagOption(tag);
  } else if (e.key === 'Escape') {
    closeTagDropdown();
  }
}

// Close dropdown when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.tag-section')) closeTagDropdown();
});


let swReg = null; // service worker registration

async function initNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
  const perm = Notification.permission;
  updateNotifUI(perm);
}

function updateNotifUI(perm) {
  const btn = document.getElementById('notifEnableBtn');
  const timesRow = document.getElementById('notifTimesRow');
  if (!btn) return;

  if (perm === 'granted') {
    btn.style.display = 'none';
    if (timesRow) {
      timesRow.style.display = 'flex';
      loadNotifSettings();
      renderWorkflowSettings();
    }
  } else if (perm === 'denied') {
    btn.textContent = 'Notifications blocked — check browser settings';
    btn.disabled = true;
  } else {
    btn.style.display = 'inline-block';
    btn.textContent = 'Enable Notifications';
    if (timesRow) timesRow.style.display = 'none';
  }
}

async function requestNotifPermission() {
  if (!('Notification' in window)) {
    alert('Notifications not supported in this browser.');
    return;
  }
  const perm = await Notification.requestPermission();
  updateNotifUI(perm);
  if (perm === 'granted') {
    saveNotifSettings();
    showSyncIndicator('✓ Notifications enabled');
  }
}

function loadNotifSettings() {
  const settings = JSON.parse(localStorage.getItem('wtt_notif') || '{}');
  const morningToggle = document.getElementById('morningToggle');
  const eveningToggle = document.getElementById('eveningToggle');
  const morningTime = document.getElementById('morningTime');
  const eveningTime = document.getElementById('eveningTime');

  const morningOn = settings.morningEnabled !== false; // default on
  const eveningOn = settings.eveningEnabled !== false; // default on

  if (morningToggle) morningToggle.classList.toggle('on', morningOn);
  if (eveningToggle) eveningToggle.classList.toggle('on', eveningOn);
  if (morningTime) morningTime.value = settings.morningTime || '08:00';
  if (eveningTime) eveningTime.value = settings.eveningTime || '17:00';
}

function toggleNotifTime(type) {
  const toggle = document.getElementById(type + 'Toggle');
  if (!toggle) return;
  toggle.classList.toggle('on');
  saveNotifSettings();
}

function saveNotifSettings() {
  const morningOn = document.getElementById('morningToggle')?.classList.contains('on') ?? true;
  const eveningOn = document.getElementById('eveningToggle')?.classList.contains('on') ?? true;
  const morningTime = document.getElementById('morningTime')?.value || '08:00';
  const eveningTime = document.getElementById('eveningTime')?.value || '17:00';

  const settings = { morningEnabled: morningOn, eveningEnabled: eveningOn, morningTime, eveningTime };
  localStorage.setItem('wtt_notif', JSON.stringify(settings));
  scheduleNotifications(settings);
}

function scheduleNotifications(settings) {
  if (!swReg || Notification.permission !== 'granted') return;
  swReg.active?.postMessage({ type: 'SCHEDULE_NOTIFICATIONS', schedule: settings });
}

// Listen for SW requests for task data
navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type === 'REQUEST_TASK_DATA') {
    const tk = todayKey();
    const workTasks = tasks.filter(t => t.category === 'work');
    const todayTasks = workTasks.filter(t => t.scheduledDate === tk);
    const data = {
      todayCount: todayTasks.filter(t => !t.done && !t.blocked).length,
      highCount: todayTasks.filter(t => !t.done && t.priority === 'high').length,
      overdueCount: workTasks.filter(t => !t.done && t.scheduledDate && t.scheduledDate < tk).length,
      pendingCount: workTasks.filter(t => !t.done).length,
      doneCount: workTasks.filter(t => t.done && t.completedAt && toDateKey(new Date(t.completedAt)) === tk).length,
    };
    e.source?.postMessage({ type: 'TASK_DATA_RESPONSE', notifType: e.data.notifType, data });
  }
});

// All done notification — fires instantly when last task completed
function checkAllDone() {
  if (Notification.permission !== 'granted') return;
  const todayWork = tasks.filter(t => t.category === 'work' && t.scheduledDate === todayKey());
  if (todayWork.length > 0 && todayWork.every(t => t.done)) {
    new Notification('All done! 🎉', {
      body: `All ${todayWork.length} work tasks completed for today.`,
      icon: '/weekly-tracker/icon-192.png',
      tag: 'all-done'
    });
  }
}

// ── Init ───────────────────────────────────────────────────────
render();
window.addEventListener('load', async () => {
  initAIStatus();
  initATH();
  refreshLastSyncUI();
  archiveData = await loadArchive().catch(() => getLocalArchiveCache());
  renderCalendar();
  setTimeout(initGoogleSync, 1000);
  setTimeout(initNotifications, 1500);
  schedulePeriodicSync();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      swReg = reg;
      // Re-schedule notifications after SW registers
      const saved = localStorage.getItem('wtt_notif');
      if (saved && Notification.permission === 'granted') {
        scheduleNotifications(JSON.parse(saved));
      }
    }).catch(() => {});
  }
});

// ── Add to Home Screen ────────────────────────────────────────
function initATH() {
  // Only show if NOT already installed as PWA and user hasn't dismissed
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const dismissed = localStorage.getItem('wtt_ath_dismissed');
  if (!isStandalone && !dismissed) {
    document.getElementById('athBanner').style.display = 'flex';
  }
}
function dismissATH() {
  document.getElementById('athBanner').style.display = 'none';
  localStorage.setItem('wtt_ath_dismissed', '1');
}

// ── Auto-refresh when app comes back to foreground ─────────────
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    render();
    refreshFromSource('foreground').catch(() => {});
  }
  if (document.visibilityState === 'hidden') {
    if (sheetId && isTokenValid()) {
      runFullSync('background').catch(() => {});
    }
  }
});

window.addEventListener('storage', e => {
  if (e.key === 'wtt_sync_ping' && document.visibilityState === 'visible') {
    refreshFromSource('peer-update').catch(() => {});
  }
  if (e.key === 'wtt_last_synced_at') refreshLastSyncUI();
});

syncChannel?.addEventListener('message', e => {
  if (e.data?.type === 'SYNC_PING' && document.visibilityState === 'visible') {
    refreshFromSource('peer-update').catch(() => {});
  }
});

// ── Pull to refresh ────────────────────────────────────────────
let ptrStartY = 0;
let ptrActive = false;
const PTR_THRESHOLD = 80;

document.addEventListener('touchstart', e => {
  if (window.scrollY === 0 && !ptrActive) {
    ptrStartY = e.touches[0].clientY;
  }
}, { passive: true });

document.addEventListener('touchmove', e => {
  if (ptrStartY === 0) return;
  const dy = e.touches[0].clientY - ptrStartY;
  if (dy > PTR_THRESHOLD && window.scrollY === 0) {
    ptrActive = true;
    document.getElementById('ptrIndicator').classList.add('visible');
  }
}, { passive: true });

document.addEventListener('touchend', async () => {
  if (!ptrActive) { ptrStartY = 0; return; }
  ptrActive = false;
  ptrStartY = 0;
  await refreshFromSource('pull-to-refresh').catch(() => {});
  render();
  setTimeout(() => {
    document.getElementById('ptrIndicator').classList.remove('visible');
  }, 600);
});
