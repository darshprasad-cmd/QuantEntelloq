(function () {
  'use strict';

  // One accessible mobile menu replaces the obsolete, CSS-hidden drawers.
  // Destinations still call the app's existing navigation and feature handlers.
  var menu, returnFocus, previousOverflow = null, scheduled = false, lessonModal = null, lessonOpener = null;
  var mobile = window.matchMedia('(max-width: 900px)');
  var groups = [
    ['Explore', [['dashboard', 'Dashboard'], ['universe', 'Watchlists'], ['signals', 'AI Signals'], ['intel', 'Intelligence'], ['macro', 'Macro'], ['scanner', 'Scanner']]],
    ['Learn & build', [['learn-explore', 'Learn'], ['ai', 'AI Studio'], ['quantlab', 'Quant Lab'], ['research', 'Research Lab']]],
    ['Practice & review', [['paper', 'Practice Trading'], ['portfolio', 'Portfolio'], ['ledger', 'Activity'], ['scenario', 'Simulations'], ['backtest', 'Backtest'], ['reports', 'Reports'], ['alerts', 'Alerts']]],
    ['Account', [['settings', 'Profile & settings']]]
  ];

  function appIsVisible() {
    var app = document.getElementById('app');
    return app && getComputedStyle(app).display !== 'none';
  }

  function visiblePage() {
    return Array.from(document.querySelectorAll('.page-anim[id^="page-"]')).find(function (page) {
      return !page.classList.contains('hidden') && getComputedStyle(page).display !== 'none';
    });
  }

  function buildMenu() {
    if (menu) return menu;
    menu = document.createElement('dialog');
    menu.id = 'qe-app-menu';
    menu.setAttribute('aria-labelledby', 'qe-app-menu-title');
    menu.innerHTML = '<div class="qe-app-menu-header"><div><small>ENTELLOQ QUANT</small><h2 id="qe-app-menu-title">Explore your workspace</h2></div><button type="button" class="qe-app-menu-close" aria-label="Close navigation">×</button></div>' +
      groups.map(function (group) {
        return '<section class="qe-app-menu-group"><h3>' + group[0] + '</h3><div>' + group[1].map(function (item) {
          return '<button type="button" data-app-page="' + item[0] + '">' + item[1] + '<span aria-hidden="true">↗</span></button>';
        }).join('') + '</div></section>';
      }).join('');
    document.body.appendChild(menu);
    menu.querySelector('.qe-app-menu-close').addEventListener('click', closeMenu);
    menu.addEventListener('keydown', function (event) {
      if (event.key !== 'Tab') return;
      var buttons = Array.from(menu.querySelectorAll('button:not(:disabled)'));
      var first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    menu.addEventListener('click', function (event) {
      var button = event.target.closest('[data-app-page]');
      if (button) {
        var page = button.getAttribute('data-app-page');
        closeMenu();
        if (typeof window.showPage === 'function') window.showPage(page);
        return;
      }
      if (event.target === menu) {
        var box = menu.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeMenu();
      }
    });
    menu.addEventListener('close', function () {
      if (previousOverflow !== null) {
        document.body.style.overflow = previousOverflow;
        previousOverflow = null;
      }
      document.body.classList.remove('qe-app-menu-open');
      syncMenuState(false);
      if (returnFocus && returnFocus.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
    });
    return menu;
  }

  function syncMenuState(open) {
    document.querySelectorAll('#qe-app-menu-toggle, #qe-menu-fab').forEach(function (button) {
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-controls', 'qe-app-menu');
      button.setAttribute('aria-haspopup', 'dialog');
    });
  }

  function openMenu(opener) {
    if (!mobile.matches || !appIsVisible()) return;
    var dialog = buildMenu();
    if (dialog.open) { closeMenu(); return; }
    // Old handlers may have left a hidden drawer's scroll lock behind.
    document.body.classList.remove('qe-mdrawer-open', 'qe-mobile-nav-open');
    document.querySelectorAll('#qe-mdrawer.open, #qe-mdrawer-back.open').forEach(function (node) { node.classList.remove('open'); });
    returnFocus = opener && opener.nodeType === 1 ? opener : document.activeElement;
    var current = visiblePage();
    dialog.querySelectorAll('[data-app-page]').forEach(function (button) {
      if (current && current.id === 'page-' + button.dataset.appPage) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('qe-app-menu-open');
    dialog.showModal();
    syncMenuState(true);
    dialog.querySelector('.qe-app-menu-close').focus({ preventScroll: true });
  }

  function closeMenu() { if (menu && menu.open) menu.close(); }

  // Use capture to prevent the legacy FAB's hidden-drawer handler from firing.
  document.addEventListener('click', function (event) {
    var opener = event.target.closest('#qe-menu-fab, #qe-app-menu-toggle');
    if (!opener || !mobile.matches) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openMenu(opener);
  }, true);
  window.qeOpenDrawer = function () { openMenu(document.activeElement); };
  window.qeCloseDrawer = closeMenu;
  mobile.addEventListener('change', function () { if (!mobile.matches) closeMenu(); updateChrome(); });

  function makeKeyboardButton(node, label) {
    if (!node || node.tagName === 'BUTTON' || node.tagName === 'A') return;
    if (node.getAttribute('role') !== 'button') node.setAttribute('role', 'button');
    if (node.tabIndex !== 0) node.tabIndex = 0;
    if (label && node.getAttribute('aria-label') !== label) node.setAttribute('aria-label', label);
  }

  function updateChrome() {
    scheduled = false;
    var right = document.querySelector('#qe-topnav .qe-tn-right');
    if (right && !document.getElementById('qe-app-menu-toggle')) {
      var button = document.createElement('button');
      button.id = 'qe-app-menu-toggle';
      button.type = 'button';
      button.innerHTML = '<span aria-hidden="true">☰</span> Menu';
      button.setAttribute('aria-label', 'Open navigation menu');
      right.appendChild(button);
      syncMenuState(!!(menu && menu.open));
    }
    var search = document.getElementById('qe-mobile-search-btn');
    if (right && !search && mobile.matches && appIsVisible()) {
      search = document.createElement('button');
      search.id = 'qe-mobile-search-btn';
      search.type = 'button';
      search.setAttribute('aria-label', 'Search assets');
      search.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
      search.addEventListener('click', function () { if (typeof window.qzSearchOpen === 'function') window.qzSearchOpen(''); });
    }
    if (right && search && search.parentElement !== right) right.insertBefore(search, right.firstChild);
    makeKeyboardButton(document.getElementById('qe-tn-logo'), 'Quant home');
    makeKeyboardButton(document.getElementById('qe-tn-user'), 'Profile and settings');
    document.querySelectorAll('.qe-tn-mitem, .qzsc-crisis-card, [onclick^="qzLearnOpen("]').forEach(function (node) { makeKeyboardButton(node); });
    var more = document.getElementById('qe-tn-more-btn');
    var panel = document.getElementById('qe-tn-more-panel');
    if (more && panel) {
      more.setAttribute('aria-controls', panel.id);
      var expanded = String(panel.classList.contains('open'));
      if (more.getAttribute('aria-expanded') !== expanded) more.setAttribute('aria-expanded', expanded);
    }
    var title = document.getElementById('page-title');
    var current = visiblePage();
    if (title && current && current.id === 'page-learn-explore' && /^learn-explore/.test(title.textContent)) title.innerHTML = 'Learn<small>Investing, one idea at a time</small>';
    var lesson = document.getElementById('qz-lesson-modal');
    if (lesson && lesson !== lessonModal) {
      lessonModal = lesson;
      lessonOpener = document.activeElement;
      lesson.setAttribute('role', 'dialog');
      lesson.setAttribute('aria-modal', 'true');
      var heading = lesson.querySelector('h2');
      if (heading) { heading.id = 'qe-app-lesson-title'; lesson.setAttribute('aria-labelledby', heading.id); }
      var close = lesson.querySelector('button');
      if (close) { close.setAttribute('aria-label', 'Close lesson'); close.focus({ preventScroll: true }); }
    } else if (!lesson && lessonModal) {
      lessonModal = null;
      if (lessonOpener && lessonOpener.isConnected && lessonOpener.getClientRects().length) lessonOpener.focus({ preventScroll: true });
      lessonOpener = null;
    }
    if (menu && menu.open && !appIsVisible()) closeMenu();
  }

  document.addEventListener('keydown', function (event) {
    var target = event.target;
    if (lessonModal && lessonModal.isConnected) {
      if (event.key === 'Escape') { event.preventDefault(); lessonModal.remove(); return; }
      if (event.key === 'Tab') {
        var buttons = Array.from(lessonModal.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]'));
        var first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && target === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && target === last) { event.preventDefault(); first.focus(); }
      }
    }
    if ((event.key === 'Enter' || event.key === ' ') && target.matches('.qe-tn-mitem, .qzsc-crisis-card, #qe-tn-logo, #qe-tn-user, [onclick^="qzLearnOpen("]')) {
      event.preventDefault();
      target.click();
    }
    if (event.key === 'Escape') {
      var panel = document.getElementById('qe-tn-more-panel');
      if (panel && panel.classList.contains('open')) {
        panel.classList.remove('open');
        var button = document.getElementById('qe-tn-more-btn');
        if (button) button.focus();
      }
    }
  });
  var observer = new MutationObserver(function () {
    if (!scheduled) { scheduled = true; requestAnimationFrame(updateChrome); }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  updateChrome();
})();
