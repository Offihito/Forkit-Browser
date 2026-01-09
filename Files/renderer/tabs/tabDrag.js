import { state } from "../core/state.js";
import { dom } from "../core/dom.js";

let draggedTab = null;

function handleDragStart(e) {
  const tabEl = e.target.closest('.tab');
  if (!tabEl) return;
  
  draggedTab = state.tabs.find(t => t.tabElement === tabEl);
  
  if (!draggedTab) return;

  tabEl.classList.add('dragging');
  
  const dummy = document.createElement('div');
  dummy.style.width = '1px';
  dummy.style.height = '1px';
  e.dataTransfer.setDragImage(dummy, 0, 0);
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
  const tabEl = e.target.closest('.tab');
  if (tabEl) tabEl.classList.remove('dragging');
  document.querySelectorAll('.tab.drag-over').forEach(el => el.classList.remove('drag-over'));
  draggedTab = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const tabEl = e.target.closest('.tab');
  if (tabEl) tabEl.classList.add('drag-over');
}

function handleDragLeave(e) {
  const tabEl = e.target.closest('.tab');
  if (tabEl) tabEl.classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  const targetEl = e.target.closest('.tab');
  if (!targetEl) return;
  
  targetEl.classList.remove('drag-over');

  if (!draggedTab) return;

  const targetTab = state.tabs.find(t => t.tabElement === targetEl);

  if (!targetTab || draggedTab === targetTab) return;

  const fromIndex = state.tabs.indexOf(draggedTab);
  const toIndex = state.tabs.indexOf(targetTab);

  if (fromIndex === -1 || toIndex === -1) return;

  const tabsBar = document.getElementById('tabs-bar');
  if (fromIndex < toIndex) {
    tabsBar.insertBefore(draggedTab.tabElement, targetEl.nextSibling);
  } else {
    tabsBar.insertBefore(draggedTab.tabElement, targetEl);
  }

  state.tabs.splice(fromIndex, 1);
  state.tabs.splice(toIndex > fromIndex ? toIndex : toIndex, 0, draggedTab);

  updateActiveTabHighlight();
}

export function updateActiveTabHighlight() {
  document.querySelectorAll('.tab').forEach(tabEl => {
    const tabObj = state.tabs.find(t => t.tabElement === tabEl);
    if (tabObj) {
      tabEl.classList.toggle('active', tabObj === state.activeTab);
    }
  });
}

export function makeTabsDraggable() {
  const tabElements = document.querySelectorAll('.tab');
  
  tabElements.forEach(tabEl => {
    if (!tabEl.dataset.tabId) {
      const tabObj = state.tabs.find(t => t.tabElement === tabEl);
      if (tabObj && tabObj.tabId) {
        tabEl.dataset.tabId = tabObj.tabId;
      } else {
        tabEl.dataset.tabId = 'tab-' + Date.now() + Math.random();
      }
    }

    tabEl.setAttribute('draggable', true);

    tabEl.removeEventListener('dragstart', handleDragStart);
    tabEl.removeEventListener('dragend', handleDragEnd);
    tabEl.removeEventListener('dragover', handleDragOver);
    tabEl.removeEventListener('dragleave', handleDragLeave);
    tabEl.removeEventListener('drop', handleDrop);

    tabEl.addEventListener('dragstart', handleDragStart);
    tabEl.addEventListener('dragend', handleDragEnd);
    tabEl.addEventListener('dragover', handleDragOver);
    tabEl.addEventListener('dragleave', handleDragLeave);
    tabEl.addEventListener('drop', handleDrop);
  });
}