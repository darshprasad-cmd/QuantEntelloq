/* Launch-only interactions. Existing authentication remains the account owner. */
(function () {
  'use strict';
  var root = document.getElementById('landing');
  if (!root || !root.classList.contains('qlaunch')) return;
  var headline = root.querySelector('h1');
  if (headline) {
    headline._qeSplit = true;
    headline.setAttribute('data-qe-cine4', '1');
    headline.setAttribute('data-qe-cine5', '1');
  }
  var dialogs = root.querySelectorAll('dialog');
  dialogs.forEach(function (dialog) {
    dialog.addEventListener('click', function (event) {
      if (event.target !== dialog) return;
      var rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', function () {
      var video = dialog.querySelector('video');
      if (video) video.pause();
    });
  });
  root.addEventListener('click', function (event) {
    var close = event.target.closest('[data-qlaunch-close]');
    if (close) { close.closest('dialog').close(); return; }
    var open = event.target.closest('[data-qlaunch-dialog]');
    if (open) {
      event.preventDefault();
      document.getElementById(open.dataset.qlaunchDialog).showModal();
      return;
    }
    var launch = event.target.closest('[data-qlaunch-start]');
    if (launch) {
      dialogs.forEach(function (dialog) { if (dialog.open) dialog.close(); });
      window.lp3Tab(launch.dataset.qlaunchStart === 'in' ? 'in' : 'up');
    }
  });
  var menu = document.getElementById('qlaunch-menu');
  var navigation = document.getElementById('qlaunch-navigation');
  function closeMenu() { navigation.removeAttribute('data-open'); menu.setAttribute('aria-expanded', 'false'); }
  menu.addEventListener('click', function () {
    var open = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(open));
    navigation.toggleAttribute('data-open', open);
  });
  navigation.addEventListener('click', function (event) { if (event.target.closest('a')) closeMenu(); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeMenu(); });
  document.addEventListener('click', function (event) { if (!event.target.closest('.qlaunch-nav')) closeMenu(); });
  var search = document.getElementById('qlaunch-search-input');
  var results = document.getElementById('qlaunch-search-results');
  var entries = [
    ['Signals', 'Understand the reasoning behind a market signal.', 'stocks aapl apple nvda nvidia buy sell ai'],
    ['Universe', 'Explore stocks, ETFs, crypto, forex and commodities.', 'markets assets equities bitcoin btc tsla tesla global'],
    ['News Intelligence', 'Connect market headlines with the bigger picture.', 'news sentiment macro economics'],
    ['Paper Trading', 'Practise a trade with virtual money.', 'portfolio practice trading risk'],
    ['Quant Lab', 'Build and backtest a strategy.', 'strategies code python backtest factors'],
    ['Learn', 'Build your understanding, one concept at a time.', 'learning lessons options risk beginners']
  ];
  function renderSearch() {
    var term = search.value.toLowerCase().trim();
    results.replaceChildren();
    entries.filter(function (entry) { return entry.join(' ').toLowerCase().includes(term); }).forEach(function (entry) {
      var button = document.createElement('button');
      button.type = 'button'; button.className = 'qlaunch-search-result'; button.dataset.qlaunchStart = 'up';
      button.appendChild(document.createTextNode(entry[0]));
      var detail = document.createElement('span'); detail.textContent = entry[1]; button.appendChild(detail);
      results.appendChild(button);
    });
    if (!results.children.length) {
      var empty = document.createElement('p'); empty.className = 'qlaunch-search-empty';
      empty.textContent = 'No matching tool. Try “strategies”, “stocks”, or “learning”. Asset search is available inside Universe.';
      results.appendChild(empty);
    }
  }
  search.addEventListener('input', renderSearch);
  renderSearch();
})();
