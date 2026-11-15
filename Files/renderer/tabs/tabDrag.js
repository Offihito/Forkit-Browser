import { state } from "../core/state.js";
import { dom } from "../core/dom.js";

let draggedTab = null;
let lastSwapTime = 0;

function animateTabReorder(tabsBar, reorderFn) {
  const tabs = Array.from(tabsBar.querySelectorAll('.tab'));
  const firstLefts = new Map();
  tabs.forEach(tabEl => {
    firstLefts.set(tabEl, tabEl.getBoundingClientRect().left);
  });

  reorderFn();

  const movedTabs = [];
  tabs.forEach(tabEl => {
    const firstLeft = firstLefts.get(tabEl);
    if (firstLeft === undefined) return;
    const lastLeft = tabEl.getBoundingClientRect().left;
    const deltaX = firstLeft - lastLeft;
    if (Math.abs(deltaX) < 0.5) return;

    tabEl.style.transition = 'none';
    tabEl.style.transform = `translateX(${deltaX}px)`;
    movedTabs.push(tabEl);
  });

  if (movedTabs.length === 0) return;

  // Force reflow so the inverted transform is committed before transitioning
  void tabsBar.offsetWidth;

  requestAnimationFrame(() => {
    movedTabs.forEach(tabEl => {
      tabEl.style.transition = 'transform 200ms cubic-bezier(0.2, 0, 0, 1)';
      tabEl.style.transform = '';

      const cleanup = () => {
        tabEl.style.transition = '';
        tabEl.removeEventListener('transitionend', onEnd);
      };
      const onEnd = (ev) => {
        if (ev.propertyName === 'transform') cleanup();
      };
      tabEl.addEventListener('transitionend', onEnd);
      setTimeout(cleanup, 230);
    });
  });
}

function reorderTabs(dragged, target) {
  const fromIndex = state.tabs.indexOf(dragged);
  const toIndex = state.tabs.indexOf(target);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return false;

  const tabsBar = document.getElementById('tabs-bar');
  if (!tabsBar) return false;

  animateTabReorder(tabsBar, () => {
    if (fromIndex < toIndex) {
      tabsBar.insertBefore(dragged.tabElement, target.tabElement.nextSibling);
    } else {
      tabsBar.insertBefore(dragged.tabElement, target.tabElement);
    }

    state.tabs.splice(fromIndex, 1);
    state.tabs.splice(toIndex, 0, dragged);
  });

  updateActiveTabHighlight();
  return true;
}

function handleDragStart(e) {
  const tabEl = e.target.closest('.tab');
  if (!tabEl) return;
  
  draggedTab = state.tabs.find(t => t.tabElement === tabEl);
  
  if (!draggedTab) return;

  lastSwapTime = 0;
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
  const targetEl = e.target.closest('.tab');
  if (!targetEl || !draggedTab || targetEl === draggedTab.tabElement) return;

  const targetTab = state.tabs.find(t => t.tabElement === targetEl);
  if (!targetTab) return;

  const now = performance.now();
  if (now - lastSwapTime < 150) return;

  const rect = targetEl.getBoundingClientRect();
  const fromIndex = state.tabs.indexOf(draggedTab);
  const toIndex = state.tabs.indexOf(targetTab);
  const midpoint = rect.left + rect.width / 2;

  if ((fromIndex < toIndex && e.clientX >= midpoint) ||
      (fromIndex > toIndex && e.clientX <= midpoint)) {
    if (reorderTabs(draggedTab, targetTab)) {
      lastSwapTime = now;
    }
  }
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

  reorderTabs(draggedTab, targetTab);
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