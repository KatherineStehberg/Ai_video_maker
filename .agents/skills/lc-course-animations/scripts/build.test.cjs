const {test} = require('node:test');
const assert = require('node:assert/strict');
const {build,validate} = require('./build.cjs');
const sample = require('../assets/example.json');
const fresh = () => structuredClone(sample);
test('rejects missing steps and unreadably long text', () => {
  const a=fresh();a.names.pop();assert.throws(()=>validate(a),/four/);
  const b=fresh();b.title='x'.repeat(71);assert.throws(()=>validate(b),/shorten/);
});
test('user text cannot escape markup or inline script', () => {
  const s=fresh();s.title='A < B & "C"';s.examples[0]='</script><script>alert(1)</script>';
  const html=build(s);
  assert.ok(html.includes('A &lt; B &amp; &quot;C&quot;'));
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(!html.includes('{{SPEC_JSON}}'));
});
test('configurable duration and Spanish interface are retained', () => {
  const s=fresh();s.duration=10;s.mode='web';s.lang='es';
  const html=build(s);assert.ok(html.includes('<html lang="es">'));
  assert.ok(html.includes('00:10 / FULL HD'));
  assert.ok(html.includes('"duration":10'));
  assert.ok(html.includes('window.duration=spec.duration'));
  assert.ok(html.includes('prefers-reduced-motion'));
});
