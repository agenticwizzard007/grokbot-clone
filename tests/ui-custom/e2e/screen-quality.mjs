// Runs in the browser. Only rendered text is audited; clipped accessible alternatives remain available.
export function inspectScreenQuality({ selector = '[data-layout="page"]', phoneBack = false, typography = true } = {}) {
  const roots = [...document.querySelectorAll(selector)];
  const visible = el => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !el.getBoundingClientRect().width) return false;
    for (let node = el; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.clipPath === 'inset(50%)' || cs.clip === 'rect(0px, 0px, 0px, 0px)') return false;
    }
    return true;
  };
  const target = el => {
    const parts = [];
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const peers = [...node.parentElement.children].filter(other => other.tagName === node.tagName);
      parts.unshift(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${peers.length > 1 ? `:nth-of-type(${peers.indexOf(node) + 1})` : ''}`);
    }
    return parts.join('>');
  };
  const issues = [];
  const add = (rule, el, actual, expected) => issues.push({ rule, target: target(el), actual, expected });
  const elements = [...new Set(roots.flatMap(root => [root, ...root.querySelectorAll('*')]))].filter(visible);
  const text = el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' ').trim();
  const forbidden = /mock|Fixture|PRIVATE|QA-|undefined|null|\[object/i;
  const rgb = color => { const values = color.match(/[\d.]+/g)?.map(Number); return values?.length >= 3 ? [...values.slice(0, 3), values[3] ?? 1] : [0, 0, 0, 0]; };
  const blend = (front, back) => [...front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3])), 1];
  const background = el => {
    const chain = []; for (let n = el; n; n = n.parentElement) chain.unshift(n);
    return chain.reduce((base, node) => blend(rgb(getComputedStyle(node).backgroundColor), base), [255, 255, 255, 1]);
  };
  const luminance = color => color.slice(0, 3).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  for (const el of elements) {
    if (el.closest('svg, script, style, option')) continue;
    const content = text(el);
    const field = el.matches('input:not([type="hidden"]), textarea') ? `${el.value} ${el.placeholder || ''}` : el.matches('select') ? [...el.selectedOptions].map(option => option.textContent).join(' ') : '';
    const match = `${content} ${field}`.match(forbidden);
    if (match) add('forbidden-visible-text', el, match[0], 'No test or serialization strings');
    if (!typography) continue;
    const cs = getComputedStyle(el);
    // Decorative glyphs are icons, not body copy; visible words never gain this exemption.
    const decorativeGlyph = el.closest('[aria-hidden="true"]') && !/[\p{L}\p{N}]/u.test(content);
    if ((content || field.trim()) && !decorativeGlyph) {
      const secondary = el.matches('small, .layout-row__subtitle, .layout-section__footer, .dashboard-muted, .dashboard-list-meta, .dashboard-chart-labels, .dashboard-library-item > span') || !!el.closest('.dashboard-chart-labels, .dashboard-list-meta, .dashboard-muted, .layout-row__subtitle, .layout-section__footer, .dashboard-status') || el.matches('kbd');
      const section = el.matches('.layout-section__header h2');
      const floor = secondary || section ? 13 : 14;
      if (parseFloat(cs.fontSize) < floor) add(secondary ? 'secondary-text-size' : 'body-text-size', el, cs.fontSize, `${floor}px minimum`);
      if (section && (cs.fontSize !== '13px' || cs.lineHeight !== '18px' || cs.fontWeight !== '600')) add('section-heading-style', el, `${cs.fontSize}/${cs.lineHeight}/${cs.fontWeight}`, '13px/18px/600');
      const bg = background(el), ink = blend(rgb(cs.color), bg), l1 = luminance(ink), l2 = luminance(bg);
      const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const minimum = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700) ? 3 : 4.5;
      if (contrast < minimum) add('text-contrast', el, Math.round(contrast * 100) / 100, minimum);
    }
    if (el.matches('button, [role="button"], input:not([type="checkbox"]):not([type="radio"]), select, textarea, [data-layout="row"]') && el.getBoundingClientRect().height < 43) add('control-height', el, Math.round(el.getBoundingClientRect().height), '44px minimum');
    if (el.matches('[data-layout="card"]')) {
      for (const key of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
        const expected = key.startsWith('border') ? '12px' : '16px';
        if (cs[key] !== expected) add(`card-${key}`, el, cs[key], expected);
      }
    }
    if (el.matches('[data-layout], .dashboard-dialog, .dashboard-widget, .dashboard-grid, .dashboard-widget-header, .dashboard-widget--stat, .appearance-fields')) {
      const step = el.closest('button, input, select, textarea, [role="button"]') ? 4 : 8;
      for (const key of ['rowGap', 'columnGap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom']) {
        // Native dialog auto margins center the sheet; they are not spacing tokens.
        if (el.matches('dialog') && key.startsWith('margin')) continue;
        const value = parseFloat(cs[key]);
        if (Number.isFinite(value) && Math.abs(value % step) > 0.1) add(`spacing-${key}`, el, cs[key], `${step}px steps`);
      }
    }
    if (el.matches('[data-layout="button-group"]')) {
      const children = [...el.children].filter(visible);
      const vertical = cs.flexDirection.startsWith('column');
      for (const child of children) {
        const style = getComputedStyle(child);
        if (vertical) { if (Math.abs(child.getBoundingClientRect().width - el.clientWidth) > 1) add('button-group-full-width', child, Math.round(child.getBoundingClientRect().width), el.clientWidth); }
        else if (style.flexGrow !== '1' || style.flexShrink !== '1' || !['0px', '0%'].includes(style.flexBasis)) add('button-group-flex', child, style.flex, '1 1 0');
      }
    }
  }
  if (typography) {
    const headings = elements.filter(el => el.matches('h1'));
    if (headings.length > 1) add('one-screen-title', headings[1], headings.length, 1);
    const shell = document.querySelector('.shell-header__title');
    if (!document.querySelector('dialog[open]') && shell && visible(shell) && headings.some(h => h.textContent.trim() === shell.textContent.trim())) add('duplicate-screen-title', shell, shell.textContent.trim(), 'One title per screen');
    if (phoneBack && innerWidth <= 760) {
      const scope = document.querySelector('dialog[open]') || document;
      const backs = [...scope.querySelectorAll('button, a')].filter(el => visible(el) && /^(?:Back|Back to .*)$/.test((el.innerText || el.getAttribute('aria-label') || '').trim()));
      if (backs.length !== 1) add('phone-back-count', roots[0] || document.body, backs.length, 1);
    }
    const helpers = elements.filter(el => el.matches('.layout-page__subtitle, .layout-section__footer, .appearance-help, .dashboard-helper'));
    const groups = new Map();
    for (const helper of helpers) {
      const content = helper.innerText.trim(), owner = helper.closest('[data-layout="card"]') || roots[0];
      const group = groups.get(owner) || []; group.push(helper); groups.set(owner, group);
      if (content.split(/\s+/).length > 8) add('helper-copy-length', helper, content.split(/\s+/).length, '8 words maximum');
      if (helpers.some(other => other !== helper && other.innerText.trim() === content)) add('repeated-helper-copy', helper, content, 'No repeated helpers');
    }
    for (const group of groups.values()) if (group.length > 1) add('helper-count', group[0], group.length, 'One helper per screen or card');
  }
  return issues;
}
