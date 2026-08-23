// API client
const API_BASE = '/api';
const UNTAGGED_FILTER = '__untagged__';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// State
const state = {
  stats: null,
  contribution: null,
  allContributions: {}, // Map of year -> {weeks, year}
  selectedDate: null,
  selectedConversation: null,
  conversations: [],
  availableYears: [],
  selectedYear: null, // null = rolling 12 months
  searchQuery: '',
  searchResults: [],
  isSearching: false,
  tooltipLocked: false, // Prevent tooltip from showing after click
  users: [],           // Available user tags
  selectedUser: null,  // Filter by user (null = all)
  tagToasts: [],       // Independently dismissible/undoable tag operations
  selectedId: null,    // Id of the conversation being viewed/loaded (keyboard nav)
  kbdHelpOpen: false,  // Keyboard shortcuts overlay (desktop/tablet)
  mobileTab: 'tag',    // Active tab in phone mode: 'tag' | 'browse'
};

let nextToastId = 1;
const pendingTagChanges = new Set();

// Phone mode: dedicated tagging-feed UI below 768px
const phoneMedia = window.matchMedia('(max-width: 767px)');
function isPhone() {
  return phoneMedia.matches;
}

// Infinite-scroll feed of untagged conversations (oldest first), phone mode only
const feed = {
  items: [],
  remaining: null,
  hasMore: true,
  loading: false,
  cursor: null,   // {t, id} of the last item ever loaded (survives removals)
  observer: null,
};

const expandedMonths = new Set(); // Month keys ('2025-07') open in phone browse view

let renderedPhoneMode = null; // Which mode the current DOM was built for

// DOM Elements
let elements = {};

// Initialize app
export async function init() {
  elements = {
    app: document.getElementById('app'),
  };
  // Rebuild the whole UI when crossing the phone/desktop boundary
  // (resize listener as fallback for environments that throttle media query events)
  const handleModeChange = () => {
    if (renderedPhoneMode === null || renderedPhoneMode === isPhone()) return;
    feed.observer?.disconnect();
    feed.observer = null;
    document.body.classList.remove('no-scroll');
    elements.app.innerHTML = '';
    render();
  };
  window.addEventListener('resize', handleModeChange);
  phoneMedia.addEventListener('change', handleModeChange);
  render();
  await loadData();
}

// Load data from API
async function loadData() {
  try {
    const [stats, users] = await Promise.all([
      fetchJSON(`${API_BASE}/stats`),
      fetchJSON(`${API_BASE}/users`),
    ]);
    state.stats = stats;
    state.users = users;

    // Determine available years from date range
    const startYear = new Date(stats.dateRange.start).getFullYear();
    const endYear = new Date(stats.dateRange.end).getFullYear();
    state.availableYears = [];
    for (let y = startYear; y <= endYear; y++) {
      state.availableYears.push(y);
    }

    // For rolling view, load current year and previous year
    const currentYear = new Date().getFullYear();
    await Promise.all([
      loadContribution(currentYear),
      loadContribution(currentYear - 1)
    ]);

    // Set current year as active for display
    state.contribution = state.allContributions[currentYear];
    render();
  } catch (err) {
    console.error('Failed to load data:', err);
    renderError(err.message);
  }
}

async function loadContribution(year) {
  try {
    let url = `${API_BASE}/contribution?year=${year}`;
    if (state.selectedUser) {
      url += `&user=${encodeURIComponent(state.selectedUser)}`;
    }
    const data = await fetchJSON(url);
    state.allContributions[year] = data;
  } catch (err) {
    console.error('Failed to load contribution:', err);
  }
}

async function loadConversations(date) {
  state.selectedDate = date;
  state.conversations = [];
  state.selectedConversation = null;
  render();

  try {
    let url = `${API_BASE}/conversations?date=${encodeURIComponent(date)}`;
    if (state.selectedUser) {
      url += `&user=${encodeURIComponent(state.selectedUser)}`;
    }
    const result = await fetchJSON(url);
    state.conversations = result.conversations;
    render();
  } catch (err) {
    console.error('Failed to load conversations:', err);
  }
}

async function loadConversation(id) {
  state.selectedId = id;
  state.selectedConversation = null;
  render();

  try {
    state.selectedConversation = await fetchJSON(`${API_BASE}/conversation/${id}`);
    render();
  } catch (err) {
    console.error('Failed to load conversation:', err);
  }
}

// Render functions
function render() {
  if (!state.stats || !state.contribution) {
    elements.app.innerHTML = '<div class="loading">Loading...</div>';
    return;
  }

  renderedPhoneMode = isPhone();
  if (renderedPhoneMode) {
    renderMobile();
    return;
  }

  elements.app.innerHTML = `
    <header>
      <h1>ChatGPT Data Viewer</h1>
      <div class="year-selector">
        <span class="year-buttons">
          <button class="${state.selectedYear === null ? 'active' : ''}"
                  onclick="window.selectYear(null)">Last 12 months</button>
          ${state.availableYears.map(y => `
            <button class="${state.selectedYear === y ? 'active' : ''}"
                    onclick="window.selectYear(${y})">${y}</button>
          `).join('')}
        </span>
        <select class="year-select" onchange="window.selectYear(this.value ? Number(this.value) : null)">
          <option value="">Last 12 months</option>
          ${state.availableYears.map(y => `
            <option value="${y}" ${state.selectedYear === y ? 'selected' : ''}>${y}</option>
          `).join('')}
        </select>
      </div>
      <div class="user-filter">
        <select id="userFilter" onchange="window.filterByUser(this.value)">
          <option value="">All users</option>
          <option value="${UNTAGGED_FILTER}" ${state.selectedUser === UNTAGGED_FILTER ? 'selected' : ''}>Untagged</option>
          ${state.users.map(u => `
            <option value="${escapeHtml(u)}" ${state.selectedUser === u ? 'selected' : ''}>${escapeHtml(u)}</option>
          `).join('')}
        </select>
      </div>
      <button class="kbd-help-btn" onclick="window.toggleKbdHelp()" title="Keyboard shortcuts (?)">
        <i class="fas fa-keyboard"></i>
      </button>
      <a href="https://github.com/alexeygrigorev/chatgpt-data-viewer" target="_blank" class="github-link">
        <i class="fab fa-github"></i>
      </a>
    </header>

    <div class="stats">
      <div class="stat">
        <div class="stat-label">Conversations</div>
        <div class="stat-value">${getVisibleCount().toLocaleString()}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Date Range</div>
        <div class="stat-value" style="font-size: 1rem;">${getVisibleDateRange()}</div>
      </div>
    </div>

    <div class="contribution-section">
      ${renderContributionGrid()}
      ${renderMonthLabels()}
      <div class="contribution-legend">
        <span>Less</span>
        <div class="legend-box" style="background: var(--contrib-0)"></div>
        <div class="legend-box" style="background: var(--contrib-1)"></div>
        <div class="legend-box" style="background: var(--contrib-2)"></div>
        <div class="legend-box" style="background: var(--contrib-3)"></div>
        <div class="legend-box" style="background: var(--contrib-4)"></div>
        <span>More</span>
      </div>
    </div>

    <div class="search-section">
      <div class="search-box">
        <input type="text"
               id="searchInput"
               placeholder="Search conversations..."
               value="${escapeHtml(state.searchQuery)}"
               onkeydown="if(event.key === 'Enter') window.doSearch()"
        />
        <button onclick="window.doSearch()">Search</button>
        ${state.searchQuery ? `<button class="search-clear" onclick="window.clearSearch()">×</button>` : ''}
      </div>
    </div>

    <div id="tooltip" class="tooltip"></div>

    <div class="main-content">
      ${state.searchQuery ? renderSearchResults() : renderConversationList()}
      ${renderConversationDetail()}
    </div>

    ${renderTagToasts()}

    <div id="jsonModal" class="modal-overlay" style="display:none" onclick="window.closeJsonModal(event)">
      <div class="modal-content" onclick="event.stopPropagation()">
        <div class="modal-header">
          <span class="modal-title">Raw JSON</span>
          <div class="modal-header-actions">
            <button class="modal-btn" onclick="window.toggleAllJsonSections()" title="Expand/Collapse all"><i class="fas fa-compress-alt"></i></button>
            <button class="modal-close" onclick="window.closeJsonModal()">&times;</button>
          </div>
        </div>
        <div class="modal-body" id="jsonModalBody">
          <div class="loading">Loading...</div>
        </div>
      </div>
    </div>

    ${renderKbdHelp()}
  `;
}

function renderKbdHelp() {
  if (!state.kbdHelpOpen) return '';
  const userRows = state.users.slice(0, 9).map((u, i) => `
    <div class="kbd-row"><span>Tag as ${escapeHtml(u)}</span><kbd>${i + 1}</kbd></div>
  `).join('');
  return `
    <div class="kbd-overlay" onclick="window.toggleKbdHelp()">
      <div class="kbd-panel" onclick="event.stopPropagation()">
        <div class="kbd-panel-title">Keyboard shortcuts</div>
        <div class="kbd-row"><span>Next / previous conversation</span><span><kbd>j</kbd> <kbd>k</kbd></span></div>
        ${userRows || '<div class="kbd-row"><span>Tag with Nth user (once users exist)</span><span><kbd>1</kbd>–<kbd>9</kbd></span></div>'}
        <div class="kbd-row"><span>Remove tag from conversation</span><kbd>x</kbd></div>
        <div class="kbd-row"><span>Undo last tag</span><kbd>u</kbd></div>
        <div class="kbd-row"><span>Focus search</span><kbd>/</kbd></div>
        <div class="kbd-row"><span>Close / clear</span><kbd>Esc</kbd></div>
        <div class="kbd-row"><span>Show this help</span><kbd>?</kbd></div>
      </div>
    </div>
  `;
}

function renderTagToasts() {
  if (state.tagToasts.length === 0) return '';
  return `
    <div class="toast-stack" aria-live="polite" aria-label="Tagging notifications">
      ${state.tagToasts.map(toast => `
        <div class="tag-toast ${toast.closing ? 'closing' : ''}" role="status">
          <span>Tagged as <strong>${escapeHtml(toast.user)}</strong></span>
          <button type="button" onclick="window.undoUserTag(${toast.id})" ${toast.undoing ? 'disabled' : ''}>
            ${toast.undoing ? 'Undoing…' : 'Undo'}
          </button>
        </div>
      `).join('')}
    </div>
  `;
}

function addTagToast(operation) {
  const toast = { ...operation, id: nextToastId++, undoing: false, closing: false, timer: null };
  state.tagToasts.push(toast);
  toast.timer = window.setTimeout(() => dismissTagToast(toast.id), 5000);
}

function dismissTagToast(id) {
  const toast = state.tagToasts.find(item => item.id === id);
  if (!toast) return;
  window.clearTimeout(toast.timer);
  toast.closing = true;
  render();
  toast.timer = window.setTimeout(() => {
    state.tagToasts = state.tagToasts.filter(item => item.id !== id);
    render();
  }, 180);
}

async function refreshContributions() {
  const years = Object.keys(state.allContributions).map(Number);
  await Promise.all(years.map(loadContribution));
  const visibleYear = state.selectedYear ?? new Date().getFullYear();
  state.contribution = state.allContributions[visibleYear];
}

function getVisibleCount() {
  if (state.selectedYear !== null) {
    return state.allContributions[state.selectedYear]?.total || 0;
  }

  // Count only last 12 months across all years
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(now.getMonth() - 12);
  twelveMonthsAgo.setHours(0, 0, 0, 0);

  let count = 0;
  const yearsNeeded = [new Date().getFullYear() - 1, new Date().getFullYear()];

  for (const year of yearsNeeded) {
    const contrib = state.allContributions[year];
    if (!contrib) continue;

    for (const day of contrib.days) {
      const date = new Date(day.date + 'T12:00:00');
      if (date >= twelveMonthsAgo && date <= now) {
        count += day.count;
      }
    }
  }
  return count;
}

function getVisibleDateRange() {
  if (state.selectedYear !== null) {
    return `${state.selectedYear}-01 → ${state.selectedYear}-12`;
  }

  // Rolling 12 months
  const now = new Date();
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(now.getMonth() - 11);
  twelveMonthsAgo.setDate(1);

  const formatMonth = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `${formatMonth(twelveMonthsAgo)} → ${formatMonth(now)}`;
}

function getCellStep() {
  const styles = getComputedStyle(document.documentElement);
  const cell = parseFloat(styles.getPropertyValue('--cell')) || 11;
  const gap = parseFloat(styles.getPropertyValue('--cell-gap')) || 2;
  return cell + gap;
}

function renderMonthLabels() {
  if (state.selectedYear !== null) {
    // Year mode - show standard month labels aligned with week columns
    const contrib = state.allContributions[state.selectedYear];
    if (!contrib) return '';

    // Grid has 7 rows, so column = day_index / 7
    // Calculate which column each month starts in
    const monthColumns = [];
    let dayIndex = 0;
    for (let month = 0; month < 12; month++) {
      monthColumns.push(dayIndex);
      const daysInMonth = new Date(state.selectedYear, month + 1, 0).getDate();
      dayIndex += daysInMonth;
    }

    const labels = [];
    for (let month = 0; month < 12; month++) {
      const column = Math.floor(monthColumns[month] / 7);
      // Each column is one cell + gap wide (CSS vars so touch devices can size up), grid has 4px padding
      const position = 4 + column * getCellStep();
      labels.push(`<span style="position: absolute; left: ${position}px;">${new Date(state.selectedYear, month, 1).toLocaleString('default', { month: 'short' })}</span>`);
    }

    return `<div class="day-labels" style="position: relative;">${labels.join('')}</div>`;
  }

  // Rolling mode - collect all visible dates and group by month
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(now.getMonth() - 12);
  twelveMonthsAgo.setHours(0, 0, 0, 0);

  const months = [];
  const yearsNeeded = [new Date().getFullYear() - 1, new Date().getFullYear()];

  // Collect visible days with their day indices
  const visibleDays = [];
  for (const year of yearsNeeded) {
    const contrib = state.allContributions[year];
    if (!contrib) continue;

    for (const day of contrib.days) {
      const date = new Date(day.date + 'T12:00:00');
      if (date >= twelveMonthsAgo && date <= now) {
        visibleDays.push({ date, count: day.count });
      }
    }
  }

  // Sort by date
  visibleDays.sort((a, b) => a.date - b.date);

  // Group by month and track first occurrence
  const monthFirstIndices = {};
  for (let i = 0; i < visibleDays.length; i++) {
    const d = visibleDays[i].date;
    const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
    if (!(monthKey in monthFirstIndices)) {
      monthFirstIndices[monthKey] = i;
    }
  }

  const labels = [];
  for (const [monthKey, dayIndex] of Object.entries(monthFirstIndices)) {
    const [year, month] = monthKey.split('-').map(Number);
    const column = Math.floor(dayIndex / 7);
    const position = 4 + column * getCellStep();
    const date = new Date(year, month, 1);
    labels.push(`<span style="position: absolute; left: ${position}px;">${date.toLocaleString('default', { month: 'short' })}</span>`);
  }

  return `<div class="day-labels" style="position: relative;">${labels.join('')}</div>`;
}

function renderContributionGrid() {
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(now.getMonth() - 12);
  twelveMonthsAgo.setHours(0, 0, 0, 0);

  const cells = [];

  if (state.selectedYear === null) {
    // Rolling 12 months mode - combine data from multiple years
    const yearsNeeded = [new Date().getFullYear() - 1, new Date().getFullYear()];

    for (const year of yearsNeeded) {
      const contrib = state.allContributions[year];
      if (!contrib) continue;

      for (const day of contrib.days) {
        const date = new Date(day.date + 'T12:00:00');

        // Only include dates in the 12-month window
        if (date < twelveMonthsAgo || date > now) {
          continue;
        }

        const count = day.count;
        let level = 0;
        if (count > 0) level = 1;
        if (count >= 3) level = 2;
        if (count >= 6) level = 3;
        if (count >= 10) level = 4;

        cells.push({ date: day.date, count, level });
      }
    }

    // Sort by date
    cells.sort((a, b) => a.date.localeCompare(b.date));
  } else {
    // Single year mode
    const contrib = state.allContributions[state.selectedYear];
    if (!contrib) return '<div class="loading">Loading...</div>';

    for (const day of contrib.days) {
      const count = day.count;
      let level = 0;
      if (count > 0) level = 1;
      if (count >= 3) level = 2;
      if (count >= 6) level = 3;
      if (count >= 10) level = 4;

      cells.push({ date: day.date, count, level });
    }
  }

  // Auto-scroll to right for rolling mode
  if (state.selectedYear === null) {
    setTimeout(() => {
      const grid = document.getElementById('grid');
      if (grid) grid.scrollLeft = grid.scrollWidth;
    }, 0);
  }

  const cellHtml = cells.map(c =>
    `<div class="day-cell level-${c.level} ${state.selectedDate === c.date ? 'selected' : ''}"
          data-date="${c.date}"
          data-count="${c.count}"></div>`
  ).join('');

  return `<div class="contribution-grid" id="grid">${cellHtml}</div>`;
}

function renderConversationList() {
  const header = `
    <div class="panel-header">
      <span>${state.selectedDate ? `Conversations for ${state.selectedDate}` : 'Select a day'}</span>
      ${state.selectedDate ? `<button class="panel-close" onclick="window.clearDate()">×</button>` : ''}
    </div>
  `;

  if (!state.selectedDate) {
    return `
      <div class="conversation-list-panel">
        ${header}
        <div class="empty-state">Click on a cell in the contribution graph to see conversations</div>
      </div>
    `;
  }

  if (state.conversations.length === 0) {
    return `
      <div class="conversation-list-panel">
        ${header}
        <div class="empty-state">No conversations found for this date</div>
      </div>
    `;
  }

  const items = state.conversations.map(c => `
    <div class="conversation-item ${state.selectedId === c.id ? 'active' : ''}"
         onclick="window.selectConversation('${c.id}')">
      <div class="conversation-title">${escapeHtml(c.title)}</div>
      <div class="conversation-meta">
        <span>${c.model || 'unknown'}</span>
        <span>${c.messageCount} messages</span>
        ${c.userTag
          ? `<span class="user-tag-badge"><i class="fas fa-user"></i> ${escapeHtml(c.userTag)}</span>`
          : renderQuickUserTagButtons(c.id)}
      </div>
    </div>
  `).join('');

  return `
    <div class="conversation-list-panel">
      ${header}
      <div class="conversation-list">${items}</div>
    </div>
  `;
}

function renderConversationDetail() {
  if (!state.selectedConversation) {
    return `
      <div class="conversation-detail">
        <div class="empty-state">Select a conversation to view messages</div>
      </div>
    `;
  }

  const c = state.selectedConversation;
  const messages = c.messages
    .filter(m => m.content && m.content.trim() !== '')
    .map(m => `
    <div class="message ${m.role}">
      <div class="message-role">${m.role}${m.name ? ` (${m.name})` : ''}</div>
      <div class="message-content">${escapeHtml(m.content)}</div>
    </div>
  `).join('');

  return `
    <div class="conversation-detail">
      <div class="detail-header">
        <div class="detail-title">${escapeHtml(c.title)}</div>
        <div class="detail-meta">
          ${c.model ? `Model: ${c.model} • ` : ''}
          Created: ${formatDateTime(c.createTime)}
        </div>
        ${c.sourceFile ? `<div class="detail-source-file"><i class="fas fa-file-code"></i> ${escapeHtml(c.sourceFile)}</div>` : ''}
        <div class="detail-user-tag">
          <i class="fas fa-user"></i>
          <input type="text" class="user-tag-input"
                 id="userTagInput"
                 placeholder="Assign user..."
                 value="${escapeHtml(c.userTag || '')}"
                 list="userSuggestions"
                 onkeydown="if(event.key === 'Enter') window.setUserTag('${c.id}', this.value)"
                 onblur="window.setUserTag('${c.id}', this.value)"
          />
          <datalist id="userSuggestions">
            ${state.users.map(u => `<option value="${escapeHtml(u)}">`).join('')}
          </datalist>
          ${!c.userTag ? renderQuickUserTagButtons(c.id, { numbered: true }) : ''}
          ${c.userTag ? `<button class="user-tag-remove" onclick="window.removeUserTag('${c.id}')" title="Remove user tag">&times;</button>` : ''}
        </div>
        <div class="detail-actions">
          <a class="action-link" onclick="window.viewRawJson('${c.id}')" title="View raw JSON">
            <i class="fas fa-code"></i>
          </a>
          <a class="action-link" onclick="window.downloadConversation()" title="Download as Markdown">
            <i class="fas fa-save"></i>
          </a>
        </div>
      </div>
      <div class="messages">${messages}<div class="messages-spacer"></div></div>
    </div>
  `;
}

function renderSearchResults() {
  const header = `
    <div class="panel-header">
      <span>Search results for "${escapeHtml(state.searchQuery)}"</span>
      <button class="panel-close" onclick="window.clearSearch()">×</button>
    </div>
  `;

  if (state.isSearching) {
    return `
      <div class="conversation-list-panel">
        ${header}
        <div class="empty-state">Searching...</div>
      </div>
    `;
  }

  if (state.searchResults.length === 0) {
    return `
      <div class="conversation-list-panel">
        ${header}
        <div class="empty-state">No results found</div>
      </div>
    `;
  }

  const items = state.searchResults.map(r => `
    <div class="conversation-item ${state.selectedId === r.id ? 'active' : ''}"
         onclick="window.selectConversation('${r.id}')">
      <div class="conversation-title">${escapeHtml(r.title)}</div>
      <div class="conversation-meta">
        <span>${r.model || 'unknown'}</span>
        <span>${new Date(r.createTime).toISOString().slice(0, 10)}</span>
        ${r.userTag
          ? `<span class="user-tag-badge"><i class="fas fa-user"></i> ${escapeHtml(r.userTag)}</span>`
          : renderQuickUserTagButtons(r.id)}
      </div>
    </div>
  `).join('');

  return `
    <div class="conversation-list-panel">
      ${header}
      <div class="conversation-list">${items}</div>
    </div>
  `;
}

function renderQuickUserTagButtons(convId, { numbered = false } = {}) {
  if (state.users.length === 0) return '';

  return `
    <span class="quick-user-tags" aria-label="Tag conversation">
      ${state.users.map((user, i) => `
        <button type="button"
                class="quick-user-tag"
                data-user="${escapeHtml(user)}"
                onclick="event.stopPropagation(); window.setUserTag('${convId}', this.dataset.user)"
                title="Tag as ${escapeHtml(user)}">${numbered && i < 9 ? `<span class="tag-num">${i + 1}</span>` : ''}${escapeHtml(user)}</button>
      `).join('')}
    </span>
  `;
}

function renderError(message) {
  elements.app.innerHTML = `
    <div class="empty-state" style="color: #f85149;">
      Error: ${escapeHtml(message)}
    </div>
  `;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDateTime(timestamp) {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// Global event handlers
window.selectYear = async (year) => {
  state.selectedYear = year;
  state.selectedDate = null;
  state.conversations = [];
  state.selectedConversation = null;
  state.searchQuery = '';
  state.searchResults = [];

  if (year !== null) {
    // Load specific year
    if (!state.allContributions[year]) {
      await loadContribution(year);
    }
    state.contribution = state.allContributions[year];
  } else {
    // Rolling view - use current year for display
    state.contribution = state.allContributions[new Date().getFullYear()];
  }
  render();
};

window.clearDate = () => {
  state.selectedDate = null;
  state.conversations = [];
  state.selectedConversation = null;
  state.searchQuery = '';
  state.searchResults = [];
  render();
};

window.selectConversation = (id) => {
  if (isPhone()) {
    window.openMobileDetail(id);
    return;
  }
  loadConversation(id);
};

window.doSearch = async (providedQuery = '') => {
  const input = document.getElementById('searchInput');
  const query = providedQuery || input?.value?.trim() || '';
  if (!query) return;

  state.searchQuery = query;
  state.isSearching = true;
  state.searchResults = [];
  render();

  try {
    let url = `${API_BASE}/search?q=${encodeURIComponent(query)}&limit=50`;
    if (state.selectedUser) {
      url += `&user=${encodeURIComponent(state.selectedUser)}`;
    }
    const result = await fetchJSON(url);
    state.searchResults = result.results;
  } catch (err) {
    console.error('Search failed:', err);
  } finally {
    state.isSearching = false;
    render();
  }
};

window.clearSearch = () => {
  state.searchQuery = '';
  state.searchResults = [];
  state.selectedConversation = null;
  render();
};

window.filterByUser = async (user) => {
  state.selectedUser = user || null;
  state.allContributions = {};
  state.selectedDate = null;
  state.conversations = [];
  state.selectedConversation = null;
  state.searchQuery = '';
  state.searchResults = [];

  const currentYear = new Date().getFullYear();
  await Promise.all([
    loadContribution(currentYear),
    loadContribution(currentYear - 1),
    ...(state.selectedYear !== null && state.selectedYear !== currentYear && state.selectedYear !== currentYear - 1
      ? [loadContribution(state.selectedYear)]
      : [])
  ]);

  state.contribution = state.selectedYear !== null
    ? state.allContributions[state.selectedYear]
    : state.allContributions[currentYear];
  render();
};

window.setUserTag = async (convId, value) => {
  const user = value.trim();
  const listedConversation = state.conversations.find(c => c.id === convId)
    || state.searchResults.find(c => c.id === convId);
  const current = state.selectedConversation?.id === convId
    ? state.selectedConversation.userTag || ''
    : listedConversation?.userTag || '';
  if (user === current) return;
  if (pendingTagChanges.has(convId)) return;
  pendingTagChanges.add(convId);

  try {
    if (user) {
      const response = await fetch(`${API_BASE}/conversation/${convId}/user-tag`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user }),
      });
      if (!response.ok) throw new Error(`Failed to tag conversation (${response.status})`);
      if (state.selectedConversation && state.selectedConversation.id === convId) {
        state.selectedConversation.userTag = user;
      }
    } else {
      await fetch(`${API_BASE}/conversation/${convId}/user-tag`, { method: 'DELETE' });
      if (state.selectedConversation && state.selectedConversation.id === convId) {
        state.selectedConversation.userTag = null;
      }
    }
    // Update user tag in conversation list too
    const conv = state.conversations.find(c => c.id === convId);
    if (conv) conv.userTag = user || null;
    const searchResult = state.searchResults.find(c => c.id === convId);
    if (searchResult) searchResult.userTag = user || null;

    if (user && !current) {
      // Stash the feed item (if loaded) so undo can put it back in the feed
      addTagToast({ convId, user, feedItem: feed.items.find(i => i.id === convId) });
    }

    // Keep the phone tagging feed in sync
    if (user) {
      removeFeedItem(convId, !current);
    } else if (current && feed.remaining != null) {
      feed.remaining++;
      updateFeedRemaining();
    }

    if (user && state.selectedUser === UNTAGGED_FILTER) {
      state.conversations = state.conversations.filter(c => c.id !== convId);
      state.searchResults = state.searchResults.filter(c => c.id !== convId);
      if (state.selectedConversation?.id === convId) state.selectedConversation = null;
    }

    // Show the filtered result and start the toast's visible lifetime immediately.
    render();

    // Refresh users list
    const [users] = await Promise.all([
      fetchJSON(`${API_BASE}/users`),
      refreshContributions(),
    ]);
    state.users = users;
    refreshFeedTagRows();
    render();
  } catch (err) {
    console.error('Failed to set user tag:', err);
  } finally {
    pendingTagChanges.delete(convId);
  }
};

window.undoUserTag = async (toastId) => {
  const toast = state.tagToasts.find(item => item.id === toastId);
  if (!toast || toast.undoing) return;

  toast.undoing = true;
  toast.closing = false;
  window.clearTimeout(toast.timer);
  render();

  try {
    const response = await fetch(`${API_BASE}/conversation/${toast.convId}/user-tag`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Failed to undo tag (${response.status})`);

    state.tagToasts = state.tagToasts.filter(item => item.id !== toastId);
    reinsertFeedItem(toast.feedItem);
    if (state.selectedConversation?.id === toast.convId) state.selectedConversation.userTag = null;
    const undoneConv = state.conversations.find(c => c.id === toast.convId);
    if (undoneConv) undoneConv.userTag = null;
    const undoneResult = state.searchResults.find(c => c.id === toast.convId);
    if (undoneResult) undoneResult.userTag = null;
    const usersPromise = fetchJSON(`${API_BASE}/users`);
    const refreshes = [refreshContributions()];
    if (state.selectedUser === UNTAGGED_FILTER && state.selectedDate && !state.searchQuery) {
      refreshes.push(loadConversations(state.selectedDate));
    } else if (state.selectedUser === UNTAGGED_FILTER && state.searchQuery) {
      refreshes.push(window.doSearch(state.searchQuery));
    }
    const [users] = await Promise.all([usersPromise, ...refreshes]);
    state.users = users;
    render();
  } catch (err) {
    console.error('Failed to undo user tag:', err);
    toast.undoing = false;
    toast.timer = window.setTimeout(() => dismissTagToast(toast.id), 5000);
    render();
  }
};

window.removeUserTag = async (convId) => {
  try {
    await fetch(`${API_BASE}/conversation/${convId}/user-tag`, { method: 'DELETE' });
    if (state.selectedConversation && state.selectedConversation.id === convId) {
      state.selectedConversation.userTag = null;
    }
    const conv = state.conversations.find(c => c.id === convId);
    if (conv) conv.userTag = null;
    if (feed.remaining != null) {
      feed.remaining++;
      updateFeedRemaining();
    }

    const users = await fetchJSON(`${API_BASE}/users`);
    state.users = users;
    render();
  } catch (err) {
    console.error('Failed to remove user tag:', err);
  }
};

window.downloadConversation = () => {
  if (!state.selectedConversation) return;

  const c = state.selectedConversation;

  // Build markdown content
  let md = `# ${c.title}\n\n`;
  md += `**Model:** ${c.model || 'unknown'}  \n`;
  md += `**Created:** ${new Date(c.createTime).toISOString()}  \n\n`;
  md += `---\n\n`;

  for (const m of c.messages) {
    if (!m.content || m.content.trim() === '') continue;

    const role = m.name ? `${m.role} (${m.name})` : m.role;
    md += `## ${role}\n\n`;
    md += `${m.content}\n\n`;
  }

  // Create blob and download
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${c.id}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

window.viewRawJson = async (id) => {
  const modal = document.getElementById('jsonModal');
  const body = document.getElementById('jsonModalBody');
  if (!modal || !body) return;

  modal.style.display = 'flex';
  body.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const raw = await fetchJSON(`${API_BASE}/conversation/${id}/raw`);
    body.innerHTML = renderCollapsibleJson(raw, '', true);
  } catch (err) {
    body.innerHTML = `<div class="empty-state" style="color: #f85149;">Failed to load raw JSON</div>`;
  }
};

window.closeJsonModal = (event) => {
  if (event && event.target !== event.currentTarget && event.currentTarget.id === 'jsonModal') return;
  const modal = document.getElementById('jsonModal');
  if (modal) modal.style.display = 'none';
};

window.toggleJsonSection = (btn) => {
  const section = btn.closest('.json-section');
  if (section) section.classList.toggle('collapsed');
};

window.toggleAllJsonSections = () => {
  const body = document.getElementById('jsonModalBody');
  if (!body) return;
  const sections = body.querySelectorAll('.json-section');
  const allCollapsed = Array.from(sections).every(s => s.classList.contains('collapsed'));
  sections.forEach(s => {
    if (allCollapsed) {
      s.classList.remove('collapsed');
    } else {
      s.classList.add('collapsed');
    }
  });
};

function renderCollapsibleJson(obj, key, isRoot) {
  if (obj === null) return `<span class="json-null">null</span>`;
  if (typeof obj === 'boolean') return `<span class="json-bool">${obj}</span>`;
  if (typeof obj === 'number') return `<span class="json-num">${obj}</span>`;
  if (typeof obj === 'string') {
    const escaped = escapeHtml(obj);
    if (escaped.length > 200) {
      return `<span class="json-str">"${escaped.slice(0, 200)}..."</span>
              <span class="json-str json-str-full" style="display:none">"${escaped}"</span>
              <button class="json-expand-str" onclick="this.previousElementSibling.style.display='inline';this.previousElementSibling.previousElementSibling.style.display='none';this.remove()">show full</button>`;
    }
    return `<span class="json-str">"${escaped}"</span>`;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return `<span class="json-bracket">[]</span>`;
    const items = obj.map((item, i) => {
      const val = renderCollapsibleJson(item, String(i), false);
      return `<div class="json-entry"><span class="json-index">${i}:</span> ${val}</div>`;
    }).join('');

    const label = key ? escapeHtml(key) : 'Array';
    const count = obj.length;
    return `
      <div class="json-section${isRoot ? '' : ''}">
        <div class="json-section-header" onclick="window.toggleJsonSection(this)">
          <i class="fas fa-chevron-down json-chevron"></i>
          <span class="json-key">${label}</span>
          <span class="json-count">[${count} items]</span>
        </div>
        <div class="json-section-body">${items}</div>
      </div>`;
  }

  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return `<span class="json-bracket">{}</span>`;

    const items = keys.map(k => {
      const val = renderCollapsibleJson(obj[k], k, false);
      return `<div class="json-entry"><span class="json-key">${escapeHtml(k)}:</span> ${val}</div>`;
    }).join('');

    const label = key ? escapeHtml(key) : 'Object';
    const count = keys.length;
    return `
      <div class="json-section${isRoot ? '' : ''}">
        <div class="json-section-header" onclick="window.toggleJsonSection(this)">
          <i class="fas fa-chevron-down json-chevron"></i>
          <span class="json-key">${label}</span>
          <span class="json-count">{${count} keys}</span>
        </div>
        <div class="json-section-body">${items}</div>
      </div>`;
  }

  return `<span>${escapeHtml(String(obj))}</span>`;
}

// Click handler for contribution grid
document.addEventListener('click', (e) => {
  const cell = e.target.closest('.day-cell');
  if (cell) {
    const date = cell.dataset.date;
    if (date) {
      // Lock tooltip temporarily to prevent it from showing after render
      state.tooltipLocked = true;
      setTimeout(() => { state.tooltipLocked = false; }, 100);
      loadConversations(date);
    }
  }
});

// Tooltip handler
document.addEventListener('mouseover', (e) => {
  if (state.tooltipLocked) return;
  const cell = e.target.closest('.day-cell');
  const tooltip = document.getElementById('tooltip');
  if (!tooltip) return;

  if (cell && cell.dataset.date) {
    const date = new Date(cell.dataset.date + 'T12:00:00');
    const count = parseInt(cell.dataset.count) || 0;
    const formattedDate = date.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });

    tooltip.innerHTML = `
      <div class="tooltip-date">${formattedDate}</div>
      <div class="tooltip-count">${count} ${count === 1 ? 'conversation' : 'conversations'}</div>
    `;
    tooltip.classList.add('visible');
  } else {
    tooltip.classList.remove('visible');
  }
}, true);

document.addEventListener('mouseout', (e) => {
  if (e.target.classList.contains('day-cell')) {
    const tooltip = document.getElementById('tooltip');
    if (tooltip) tooltip.classList.remove('visible');
  }
}, true);

// Keyboard shortcuts (desktop + tablet with keyboard)
function isEditableTarget(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function activeConversationList() {
  return state.searchQuery ? state.searchResults : state.conversations;
}

function moveSelection(delta) {
  const list = activeConversationList();
  if (!list.length) return;
  let idx = list.findIndex(c => c.id === state.selectedId);
  if (idx === -1) {
    idx = delta > 0 ? 0 : list.length - 1;
  } else {
    idx = Math.min(Math.max(idx + delta, 0), list.length - 1);
  }
  loadConversation(list[idx].id);
  requestAnimationFrame(() => {
    document.querySelector('.conversation-item.active')?.scrollIntoView({ block: 'nearest' });
  });
}

window.toggleKbdHelp = () => {
  state.kbdHelpOpen = !state.kbdHelpOpen;
  render();
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('jsonModal');
    if (modal && modal.style.display !== 'none') {
      modal.style.display = 'none';
      return;
    }
    if (state.kbdHelpOpen) {
      window.toggleKbdHelp();
      return;
    }
    if (isPhone()) {
      window.closeMobileDetail();
      return;
    }
    if (isEditableTarget(e.target)) e.target.blur();
    return;
  }

  if (isPhone() || isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === '/') {
    e.preventDefault();
    document.getElementById('searchInput')?.focus();
  } else if (e.key === '?') {
    e.preventDefault();
    window.toggleKbdHelp();
  } else if (e.key === 'j') {
    moveSelection(1);
  } else if (e.key === 'k') {
    moveSelection(-1);
  } else if (/^[1-9]$/.test(e.key)) {
    const user = state.users[Number(e.key) - 1];
    if (user && state.selectedId) window.setUserTag(state.selectedId, user);
  } else if (e.key === 'x') {
    if (state.selectedId) window.removeUserTag(state.selectedId);
  } else if (e.key === 'u') {
    const last = state.tagToasts[state.tagToasts.length - 1];
    if (last) window.undoUserTag(last.id);
  }
});

document.addEventListener('mousemove', (e) => {
  const tooltip = document.getElementById('tooltip');
  if (tooltip && tooltip.classList.contains('visible')) {
    tooltip.style.left = (e.clientX + 12) + 'px';
    tooltip.style.top = (e.clientY + 12) + 'px';
  }
});

// ============================================================
// Phone mode (<768px): tagging feed + browse tabs
// ============================================================

let monthsInitialized = false;

function renderMobile() {
  let shell = elements.app.querySelector('.mobile-app');
  if (!shell) {
    elements.app.innerHTML = mobileShellHtml();
    initFeed();
    shell = elements.app.querySelector('.mobile-app');
  }

  const tagView = document.getElementById('tagView');
  const browseView = document.getElementById('browseView');
  if (tagView) tagView.hidden = state.mobileTab !== 'tag';
  if (browseView) browseView.hidden = state.mobileTab !== 'browse';
  document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === state.mobileTab);
  });

  updateFeedRemaining();
  renderBrowseContent();
  updateMobileDetailTagRow();

  const toasts = document.getElementById('mobileToasts');
  if (toasts) toasts.innerHTML = renderTagToasts();
}

function mobileShellHtml() {
  return `
    <div class="mobile-app">
      <header class="mobile-header">
        <h1>ChatGPT Viewer</h1>
        <span class="feed-remaining" id="feedRemaining"></span>
      </header>
      <main class="mobile-main">
        <section id="tagView" class="mobile-view">
          <div class="feed-list" id="feedList"></div>
          <div class="feed-status" id="feedStatus"></div>
        </section>
        <section id="browseView" class="mobile-view" hidden></section>
      </main>
      <nav class="bottom-nav">
        <button type="button" class="bottom-nav-btn active" data-tab="tag" onclick="window.setMobileTab('tag')">
          <i class="fas fa-tags"></i><span>Tag</span>
        </button>
        <button type="button" class="bottom-nav-btn" data-tab="browse" onclick="window.setMobileTab('browse')">
          <i class="fas fa-calendar-days"></i><span>Browse</span>
        </button>
      </nav>
      <div id="mobileDetail" class="mobile-detail" hidden></div>
      <div id="mobileToasts"></div>
      <div id="jsonModal" class="modal-overlay" style="display:none" onclick="window.closeJsonModal(event)">
        <div class="modal-content" onclick="event.stopPropagation()">
          <div class="modal-header">
            <span class="modal-title">Raw JSON</span>
            <div class="modal-header-actions">
              <button class="modal-btn" onclick="window.toggleAllJsonSections()" title="Expand/Collapse all"><i class="fas fa-compress-alt"></i></button>
              <button class="modal-close" onclick="window.closeJsonModal()">&times;</button>
            </div>
          </div>
          <div class="modal-body" id="jsonModalBody">
            <div class="loading">Loading...</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

window.setMobileTab = (tab) => {
  state.mobileTab = tab;
  render();
};

// --- Tagging feed ---

function initFeed() {
  feed.observer?.disconnect();
  const sentinel = document.getElementById('feedStatus');
  const rootEl = document.getElementById('tagView');
  if (!sentinel || !rootEl) return;
  feed.observer = new IntersectionObserver((entries) => {
    if (entries.some(en => en.isIntersecting)) loadFeedPage();
  }, { root: rootEl, rootMargin: '600px' });
  feed.observer.observe(sentinel);

  // Scroll fallback for environments where IntersectionObserver is throttled
  rootEl.addEventListener('scroll', () => {
    if (rootEl.scrollTop + rootEl.clientHeight >= rootEl.scrollHeight - 600) loadFeedPage();
  }, { passive: true });

  if (feed.items.length) {
    rebuildFeedDom();
  } else {
    loadFeedPage();
  }
  updateFeedRemaining();
  updateFeedStatus();
}

async function loadFeedPage() {
  if (feed.loading || !feed.hasMore) return;
  feed.loading = true;
  updateFeedStatus();
  try {
    let url = `${API_BASE}/conversations/untagged?limit=15`;
    if (feed.cursor) {
      url += `&after_time=${feed.cursor.t}&after_id=${encodeURIComponent(feed.cursor.id)}`;
    }
    const data = await fetchJSON(url);
    feed.remaining = data.remaining;
    feed.hasMore = data.hasMore;
    if (data.conversations.length) {
      const last = data.conversations[data.conversations.length - 1];
      feed.cursor = { t: last.createTimestamp, id: last.id };
      const known = new Set(feed.items.map(i => i.id));
      const fresh = data.conversations.filter(c => !known.has(c.id));
      feed.items.push(...fresh);
      appendFeedCards(fresh);
    }
    updateFeedRemaining();
  } catch (err) {
    console.error('Failed to load untagged feed:', err);
  } finally {
    feed.loading = false;
    updateFeedStatus();
  }
}

function appendFeedCards(items) {
  const listEl = document.getElementById('feedList');
  if (!listEl || !items.length) return;
  listEl.insertAdjacentHTML('beforeend', items.map(feedCardHtml).join(''));
}

function rebuildFeedDom() {
  const listEl = document.getElementById('feedList');
  if (!listEl) return;
  listEl.innerHTML = feed.items.map(feedCardHtml).join('');
}

function feedCardHtml(item) {
  const preview = (item.preview && item.preview.length)
    ? item.preview.map(p => `
        <div class="preview-msg ${p.role}">
          <span class="preview-role">${p.role}</span>${escapeHtml(p.content)}
        </div>`).join('')
    : '<div class="preview-msg empty">No message content</div>';

  return `
    <article class="feed-card" data-id="${item.id}">
      <div class="feed-card-head">
        <span class="feed-card-date">${formatFeedDate(item.createTime)}</span>
        <span class="feed-card-meta">${item.messageCount} msgs${item.model ? ` · ${escapeHtml(item.model)}` : ''}</span>
      </div>
      <div class="feed-card-tagrow">${feedTagRowInner(item.id)}</div>
      <button type="button" class="feed-card-title" onclick="window.openMobileDetail('${item.id}')">
        <span>${escapeHtml(item.title)}</span>
        <i class="fas fa-chevron-right"></i>
      </button>
      <div class="feed-card-preview">${preview}</div>
    </article>
  `;
}

function feedTagRowInner(convId) {
  const buttons = state.users.map(u => `
    <button type="button" class="feed-tag-btn" data-user="${escapeHtml(u)}"
            onclick="window.setUserTag('${convId}', this.dataset.user)">${escapeHtml(u)}</button>
  `).join('');
  return `${buttons}
    <button type="button" class="feed-tag-btn feed-tag-new" title="Tag with a new user"
            onclick="window.feedNewUser(this, '${convId}')"><i class="fas fa-plus"></i>${state.users.length === 0 ? ' Add user' : ''}</button>`;
}

function refreshFeedTagRows() {
  document.querySelectorAll('.feed-card .feed-card-tagrow').forEach(row => {
    if (row.contains(document.activeElement) && isEditableTarget(document.activeElement)) return;
    const id = row.closest('.feed-card')?.dataset.id;
    if (id) row.innerHTML = feedTagRowInner(id);
  });
}

window.feedNewUser = (btn, convId) => {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'feed-tag-input';
  input.placeholder = 'User name…';
  input.enterKeyHint = 'done';
  input.autocapitalize = 'off';
  const commit = () => {
    const v = input.value.trim();
    if (v && !input.dataset.done) {
      input.dataset.done = '1';
      window.setUserTag(convId, v);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') input.replaceWith(btn);
  });
  input.addEventListener('blur', () => {
    if (!input.dataset.done && !input.value.trim()) input.replaceWith(btn);
    else commit();
  });
  btn.replaceWith(input);
  input.focus();
};

function removeFeedItem(convId, wasUntagged = true) {
  const idx = feed.items.findIndex(i => i.id === convId);
  if (idx !== -1) feed.items.splice(idx, 1);
  if (wasUntagged && feed.remaining != null && feed.remaining > 0) feed.remaining--;
  const card = document.querySelector(`.feed-card[data-id="${convId}"]`);
  if (card) {
    card.classList.add('removing');
    window.setTimeout(() => {
      card.remove();
      updateFeedStatus();
    }, 200);
  }
  updateFeedRemaining();
  maybeLoadMoreFeed();
}

function reinsertFeedItem(item) {
  if (feed.remaining != null) feed.remaining++;
  updateFeedRemaining();
  if (!item) return;
  if (feed.items.some(i => i.id === item.id)) return;
  const pos = feed.items.findIndex(i =>
    i.createTimestamp > item.createTimestamp ||
    (i.createTimestamp === item.createTimestamp && i.id > item.id));
  if (pos === -1) {
    const beforeCursor = !feed.cursor ||
      item.createTimestamp < feed.cursor.t ||
      (item.createTimestamp === feed.cursor.t && item.id <= feed.cursor.id);
    if (!beforeCursor) return; // a future page will bring it back
    feed.items.push(item);
  } else {
    feed.items.splice(pos, 0, item);
  }
  rebuildFeedDom();
  updateFeedStatus();
}

function maybeLoadMoreFeed() {
  if (feed.items.length < 8 && feed.hasMore && !feed.loading && document.getElementById('feedList')) {
    loadFeedPage();
  }
}

function updateFeedRemaining() {
  const el = document.getElementById('feedRemaining');
  if (!el) return;
  el.textContent = feed.remaining != null ? `${feed.remaining.toLocaleString()} untagged` : '';
}

function updateFeedStatus() {
  const el = document.getElementById('feedStatus');
  if (!el) return;
  if (feed.loading) {
    el.innerHTML = '<div class="loading">Loading...</div>';
  } else if (!feed.hasMore && feed.items.length === 0) {
    el.innerHTML = `
      <div class="feed-empty">
        <div class="feed-empty-icon"><i class="fas fa-check-circle"></i></div>
        <div>All conversations are tagged!</div>
      </div>`;
  } else if (!feed.hasMore) {
    el.innerHTML = '<div class="feed-end">End of untagged conversations</div>';
  } else {
    el.innerHTML = '';
  }
}

function formatFeedDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

// --- Browse tab ---

function renderBrowseContent() {
  const el = document.getElementById('browseView');
  if (!el) return;
  // Don't clobber in-progress typing (toast timers trigger re-renders)
  if (el.contains(document.activeElement) && isEditableTarget(document.activeElement)) return;

  let html;
  if (state.searchQuery) html = browseSearchHtml();
  else if (state.selectedDate) html = browseDayHtml();
  else html = browseMonthsHtml();

  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
}

function browseSearchBoxHtml() {
  return `
    <div class="browse-search">
      <input id="searchInput" type="search" placeholder="Search conversations…" enterkeyhint="search"
             value="${escapeHtml(state.searchQuery)}"
             onkeydown="if(event.key === 'Enter') { this.blur(); window.doSearch(); }" />
      ${state.searchQuery ? '<button type="button" class="browse-search-clear" onclick="window.clearSearch()"><i class="fas fa-times"></i></button>' : ''}
    </div>
  `;
}

function browseMonthsHtml() {
  const months = getBrowseMonths();
  if (!monthsInitialized && months.length) {
    expandedMonths.add(months[0].key);
    monthsInitialized = true;
  }

  const monthCards = months.map(m => {
    const expanded = expandedMonths.has(m.key);
    return `
      <div class="month-card">
        <button type="button" class="month-head" onclick="window.toggleMonth('${m.key}')">
          <i class="fas fa-chevron-${expanded ? 'down' : 'right'}"></i>
          <span>${m.label}</span>
          <span class="month-count">${m.total}</span>
        </button>
        ${expanded ? monthGridHtml(m) : ''}
      </div>
    `;
  }).join('');

  return `
    ${browseSearchBoxHtml()}
    <div class="browse-controls">
      <select onchange="window.selectYear(this.value ? Number(this.value) : null)">
        <option value="">Last 12 months</option>
        ${state.availableYears.map(y => `<option value="${y}" ${state.selectedYear === y ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
      <select onchange="window.filterByUser(this.value)">
        <option value="">All users</option>
        <option value="${UNTAGGED_FILTER}" ${state.selectedUser === UNTAGGED_FILTER ? 'selected' : ''}>Untagged</option>
        ${state.users.map(u => `<option value="${escapeHtml(u)}" ${state.selectedUser === u ? 'selected' : ''}>${escapeHtml(u)}</option>`).join('')}
      </select>
    </div>
    ${monthCards || '<div class="empty-state">No conversations in this range</div>'}
  `;
}

function contribLevel(count) {
  if (count >= 10) return 4;
  if (count >= 6) return 3;
  if (count >= 3) return 2;
  if (count > 0) return 1;
  return 0;
}

function getBrowseMonths() {
  const byMonth = new Map();
  const addDay = (day) => {
    const key = day.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(day);
  };

  if (state.selectedYear !== null) {
    (state.allContributions[state.selectedYear]?.days || []).forEach(addDay);
  } else {
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    const twelveMonthsAgo = new Date(now);
    twelveMonthsAgo.setMonth(now.getMonth() - 12);
    twelveMonthsAgo.setHours(0, 0, 0, 0);
    for (const year of [now.getFullYear() - 1, now.getFullYear()]) {
      const contrib = state.allContributions[year];
      if (!contrib) continue;
      for (const day of contrib.days) {
        const date = new Date(day.date + 'T12:00:00');
        if (date >= twelveMonthsAgo && date <= now) addDay(day);
      }
    }
  }

  return [...byMonth.entries()]
    .map(([key, days]) => {
      const [y, mo] = key.split('-').map(Number);
      return {
        key,
        label: new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        total: days.reduce((s, d) => s + d.count, 0),
        days: days.sort((a, b) => a.date.localeCompare(b.date)),
      };
    })
    .filter(m => m.total > 0) // nothing to browse in an empty month
    .sort((a, b) => b.key.localeCompare(a.key)); // newest month first
}

function monthGridHtml(m) {
  const dows = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<span class="dow">${d}</span>`).join('');
  const firstDow = new Date(m.days[0].date + 'T12:00:00').getDay();
  const blanks = Array.from({ length: firstDow }, () => '<span></span>').join('');
  const cells = m.days.map(d => {
    const level = contribLevel(d.count);
    return `
      <button type="button" class="mini-day level-${level}" ${d.count === 0 ? 'disabled' : ''}
              onclick="window.selectBrowseDay('${d.date}')"
              aria-label="${d.date}: ${d.count} conversations">${Number(d.date.slice(8))}</button>`;
  }).join('');
  return `<div class="month-grid">${dows}${blanks}${cells}</div>`;
}

window.toggleMonth = (key) => {
  if (expandedMonths.has(key)) expandedMonths.delete(key);
  else expandedMonths.add(key);
  render();
};

window.selectBrowseDay = (date) => {
  loadConversations(date);
};

function browseDayHtml() {
  const items = state.conversations.map(c => `
    <div class="conversation-item" onclick="window.selectConversation('${c.id}')">
      <div class="conversation-title">${escapeHtml(c.title)}</div>
      <div class="conversation-meta">
        <span>${c.messageCount} msgs</span>
        ${c.userTag
          ? `<span class="user-tag-badge"><i class="fas fa-user"></i> ${escapeHtml(c.userTag)}</span>`
          : renderQuickUserTagButtons(c.id)}
      </div>
    </div>
  `).join('');

  return `
    <div class="browse-subhead">
      <button type="button" class="mobile-back" onclick="window.clearDate()"><i class="fas fa-arrow-left"></i></button>
      <span class="browse-subhead-title">${state.selectedDate}</span>
      <span class="browse-subhead-count">${state.conversations.length}</span>
    </div>
    <div class="mobile-conv-list">
      ${items || '<div class="empty-state">No conversations on this day</div>'}
    </div>
  `;
}

function browseSearchHtml() {
  let body;
  if (state.isSearching) {
    body = '<div class="loading">Searching...</div>';
  } else if (state.searchResults.length === 0) {
    body = '<div class="empty-state">No results found</div>';
  } else {
    body = state.searchResults.map(r => `
      <div class="conversation-item" onclick="window.selectConversation('${r.id}')">
        <div class="conversation-title">${escapeHtml(r.title)}</div>
        <div class="conversation-meta">
          <span>${new Date(r.createTime).toISOString().slice(0, 10)}</span>
          ${r.userTag
            ? `<span class="user-tag-badge"><i class="fas fa-user"></i> ${escapeHtml(r.userTag)}</span>`
            : renderQuickUserTagButtons(r.id)}
        </div>
      </div>
    `).join('');
  }
  return `
    ${browseSearchBoxHtml()}
    <div class="mobile-conv-list">${body}</div>
  `;
}

// --- Full-screen conversation detail ---

window.openMobileDetail = async (id) => {
  const overlay = document.getElementById('mobileDetail');
  if (!overlay) return;
  overlay.hidden = false;
  document.body.classList.add('no-scroll');
  overlay.innerHTML = `
    <div class="mobile-detail-header">
      <button type="button" class="mobile-back" onclick="window.closeMobileDetail()"><i class="fas fa-arrow-left"></i></button>
      <div class="mobile-detail-titlewrap"><div class="mobile-detail-title">Loading...</div></div>
    </div>
    <div class="loading">Loading...</div>
  `;
  try {
    const conv = await fetchJSON(`${API_BASE}/conversation/${id}`);
    state.selectedConversation = conv;
    state.selectedId = id;
    overlay.innerHTML = mobileDetailHtml(conv);
  } catch (err) {
    console.error('Failed to load conversation:', err);
    overlay.innerHTML = `
      <div class="mobile-detail-header">
        <button type="button" class="mobile-back" onclick="window.closeMobileDetail()"><i class="fas fa-arrow-left"></i></button>
        <div class="mobile-detail-titlewrap"><div class="mobile-detail-title">Error</div></div>
      </div>
      <div class="empty-state" style="color:#f85149">Failed to load conversation</div>
    `;
  }
};

window.closeMobileDetail = () => {
  const overlay = document.getElementById('mobileDetail');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  overlay.innerHTML = '';
  document.body.classList.remove('no-scroll');
  state.selectedConversation = null;
};

function mobileDetailHtml(c) {
  const messages = c.messages
    .filter(m => m.content && m.content.trim() !== '')
    .map(m => `
      <div class="message ${m.role}">
        <div class="message-role">${m.role}${m.name ? ` (${m.name})` : ''}</div>
        <div class="message-content">${escapeHtml(m.content)}</div>
      </div>
    `).join('');

  return `
    <div class="mobile-detail-header">
      <button type="button" class="mobile-back" onclick="window.closeMobileDetail()"><i class="fas fa-arrow-left"></i></button>
      <div class="mobile-detail-titlewrap">
        <div class="mobile-detail-title">${escapeHtml(c.title)}</div>
        <div class="mobile-detail-meta">${formatDateTime(c.createTime)}${c.model ? ` · ${escapeHtml(c.model)}` : ''}</div>
      </div>
      <a class="action-link" onclick="window.viewRawJson('${c.id}')" title="View raw JSON"><i class="fas fa-code"></i></a>
      <a class="action-link" onclick="window.downloadConversation()" title="Download as Markdown"><i class="fas fa-save"></i></a>
    </div>
    <div class="mobile-detail-tagrow" id="mobileDetailTagRow">${mobileDetailTagRowInner(c)}</div>
    <div class="messages mobile-messages">${messages || '<div class="empty-state">No message content</div>'}</div>
  `;
}

function mobileDetailTagRowInner(c) {
  if (c.userTag) {
    return `
      <span class="user-tag-badge"><i class="fas fa-user"></i> ${escapeHtml(c.userTag)}</span>
      <button type="button" class="user-tag-remove" onclick="window.removeUserTag('${c.id}')" title="Remove user tag">&times;</button>
    `;
  }
  return feedTagRowInner(c.id);
}

function updateMobileDetailTagRow() {
  const row = document.getElementById('mobileDetailTagRow');
  if (!row || !state.selectedConversation) return;
  if (row.contains(document.activeElement) && isEditableTarget(document.activeElement)) return;
  row.innerHTML = mobileDetailTagRowInner(state.selectedConversation);
}
