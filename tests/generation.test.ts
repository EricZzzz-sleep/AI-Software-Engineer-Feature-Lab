import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAIGenerator } from '../src/generation.js';

const brief = { goal: 'Invite team leads, under 100 words', facts: 'Launch October 1', tone: 'Warm' };
const completed = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Draft copy' }] }] };
test('provider sends brief and server credentials to Responses and extracts text', async () => {
  const generate = openAIGenerator({ apiKey: 'test-secret', model: 'test-model' }, async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-secret');
    const input = JSON.parse(String(init?.body));
    assert.equal(input.model, 'test-model');
    assert.equal(input.store, false);
    assert.deepEqual(JSON.parse(input.input), brief);
    assert.match(input.instructions, /never invent/);
    return Response.json(completed);
  });
  assert.equal(await generate!(brief), 'Draft copy');
  assert.equal(openAIGenerator({ apiKey: ' ' }), null);
});
test('provider handles HTTP errors, invalid output, refusal, network failures and timeout safely', async () => {
  const cases: [typeof fetch, number][] = [
    [async () => Response.json({ error: 'secret' }, { status: 401 }), 503],
    [async () => Response.json({}, { status: 429 }), 503],
    [async () => Response.json({}, { status: 500 }), 502],
    [async () => Response.json({ ...completed, status: 'incomplete' }), 502],
    [async () => Response.json({ status: 'completed', output: [] }), 502],
    [async () => new Response('invalid JSON'), 502],
    [async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }), 422],
    [async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(20001) }] }] }), 502],
    [async () => { throw new Error('secret'); }, 502],
    [async () => { throw new DOMException('timeout', 'TimeoutError'); }, 504],
  ];
  for (const [request, status] of cases) {
    await assert.rejects(openAIGenerator({ apiKey: 'test-secret' }, request)!(brief), (error: unknown) => {
      assert.equal((error as { status: number }).status, status);
      assert.doesNotMatch((error as Error).message, /secret/);
      return true;
    });
  }
});
