const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { writeAndroidClipboard } = require('../adapters/douyin-phone/android_clipboard');

test('Unicode clipboard writing uses a real gesture and escapes script delimiters', async () => {
  const expected = 'Amalfi Lemon 上海 </script><script>bad()</script>\u2028';
  let target, script, gesture, written, acknowledged;
  const elements = {
    textarea: { addEventListener() {}, focus() {} },
    '#status': {}, '#read': {},
  };
  const adb = {
    serial: 'mock-phone', executable: 'mock-adb', execute: async () => ({ stdout: '' }),
    command: async () => '', wait: async () => {},
    shell: async (...args) => {
      target = args.find(x => String(x).startsWith('http://127.0.0.1:'));
      const html = await (await fetch(target)).text();
      assert.equal(html.includes('</script><script>bad()'), false);
      script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
      vm.runInNewContext(script, {
        document: { querySelector: selector => elements[selector] },
        navigator: { clipboard: { writeText: async value => { written = value; } } },
        location: { pathname: new URL(target).pathname },
        fetch: async (_url, options) => { acknowledged = true; return fetch(target, options); },
      });
      assert.equal(written, undefined);
      return '';
    },
    tapLabel: async labels => {
      assert.equal(labels[0], '写入搜索文字'); gesture = true;
      await elements['#read'].onclick(); return true;
    },
  };
  await writeAndroidClipboard(adb, expected, { port: 0 });
  assert.equal(gesture, true); assert.equal(acknowledged, true); assert.equal(written, expected);
});

test('clipboard writing rejects empty and oversized strings before touching a phone', async () => {
  for (const value of ['', 'a'.repeat(8193), 1]) await assert.rejects(writeAndroidClipboard({}, value));
});
