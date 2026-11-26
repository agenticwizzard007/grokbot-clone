import assert from 'node:assert/strict';

export const settleComposer = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

export async function composerGeometry(page) {
  await settleComposer(page);
  // A browser input can enqueue sizing after our frame callbacks under load.
  // Require all text to fit or internal scrolling to be enabled before sampling.
  await page.waitForFunction(() => {
    const input = document.querySelector('.composer__input');
    return input && (getComputedStyle(input).overflowY === 'auto' || input.scrollHeight <= input.clientHeight);
  });
  return page.locator('.composer').evaluate(composer => {
    const input = composer.querySelector('.composer__input');
    const style = getComputedStyle(input), outer = getComputedStyle(composer);
    const rect = el => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, row: s.gridRow, column: s.gridColumn };
    };
    // Independently lay out the actual visible text at its rendered width. No
    // assumed chip/control widths and no dependency on Composer's hidden probe.
    const probe = document.createElement('div');
    Object.assign(probe.style, { position: 'fixed', visibility: 'hidden', boxSizing: 'content-box',
      width: `${input.getBoundingClientRect().width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`,
      font: style.font, letterSpacing: style.letterSpacing, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
    probe.textContent = `${input.value || ' '}${input.value.endsWith('\n') ? ' ' : ''}`;
    document.body.append(probe);
    const textHeight = probe.getBoundingClientRect().height;
    probe.remove();
    return { composer: rect(composer), input: rect(input), line: parseFloat(style.lineHeight), textHeight,
      padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
      base: parseFloat(outer.paddingTop) + parseFloat(outer.paddingBottom) + parseFloat(outer.borderTopWidth) + parseFloat(outer.borderBottomWidth),
      max: parseFloat(outer.maxHeight), min: parseFloat(outer.minHeight), overflow: style.overflowY,
      scrollHeight: input.scrollHeight, clientHeight: input.clientHeight,
      controls: ['.composer__plus-anchor', '.model-pill-anchor', '.composer__right'].map(selector => rect(composer.querySelector(selector))),
      action: rect(composer.querySelector('.composer__right button')),
      provider: rect(composer.querySelector('.model-pill__provider')),
    };
  });
}

export function assertComposerSlots(actual, before, label = '') {
  const near = (a, b, detail) => assert.ok(Math.abs(a - b) <= 1, `${label} ${detail}: ${a} vs ${b}`);
  near(actual.input.x, before.input.x, 'field x');
  near(actual.input.width, before.input.width, 'field width');
  for (let i = 0; i < actual.controls.length; i++) {
    const a = actual.controls[i], b = before.controls[i];
    assert.equal(a.row, b.row, `${label} control ${i} row`);
    assert.equal(a.column, b.column, `${label} control ${i} column`);
    near(a.x, b.x, `control ${i} x`);
    near(a.width, b.width, `control ${i} width`);
    near(actual.composer.bottom - a.bottom, before.composer.bottom - b.bottom, `control ${i} bottom inset`);
  }
  near(actual.action.x, before.action.x, 'send/voice x');
  near(actual.action.bottom, actual.controls[0].bottom, 'send/voice shares the controls row');
  near(actual.input.bottom, actual.controls[0].bottom, 'controls align with the field bottom');
  near(actual.provider.x, before.provider.x, 'provider slot x');
  assert.equal(actual.provider.width, 16, `${label} reserved provider width`);
  assert.equal(actual.provider.height, 16, `${label} reserved provider height`);
  assert.ok(actual.composer.height <= actual.max + 1, `${label} composer height bound`);
  assert.ok(actual.clientHeight <= 200, `${label} field height bound`);
}
