/**
 * @file packages/core/vitest/metrics.test.ts
 * @description Tests the native metrics listener, live snapshots and failure isolation.
 * @author Max Falk
 */

import { createServer } from 'node:http';

import { getFreePort } from '@matterbridge/test-utils';
import { Registry } from '@prometheus-io/client';
import { AnsiLogger } from 'node-ansi-logger';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { MetricsServer, type MetricsSnapshot } from '../src/metrics.js';

const log = new AnsiLogger({ logName: 'MetricsTest' });
let metrics: MetricsServer | undefined;
afterEach(async () => {
  await metrics?.close();
  metrics = undefined;
});

/**
 * Build a small fresh snapshot with a paired but disconnected controller
 * @returns {MetricsSnapshot} Safe fixture, including label escaping.
 */
function snapshot(): MetricsSnapshot {
  return {
    plugins: [{ name: 'test-plugin', ready: true, exports: 1, connection: { connected: true, subscribed: true, lastHeartbeatTimestampSeconds: 123 } }],
    nodes: [{ node: 'root', online: true, fabrics: [{ controller: 'fabric-1', sessions: 0, subscriptions: 0 }] }],
  };
}

describe('native metrics', () => {
  test('should expose valid live observations and distinguish pairing from subscriptions', async () => {
    metrics = new MetricsServer(snapshot, log);
    const text = await metrics.collect();
    expect(text).toContain('# TYPE matterbridge_plugin_ready gauge');
    expect(text).toContain('matterbridge_collection_success 1');
    expect(text).toContain('matterbridge_fabric_present{node="root",controller="fabric-1"} 1');
    expect(text).toContain('matterbridge_active_subscriptions{node="root",controller="fabric-1"} 0');
    expect(text).toContain('matterbridge_subscription_delivery_supported 0');
    expect(text).not.toContain('access_token');
  });

  test('should remove disappeared series and never reuse healthy observations after failure', async () => {
    const observe = vi.fn(snapshot);
    metrics = new MetricsServer(observe, log);
    await metrics.collect();
    observe.mockImplementation(() => {
      throw new Error('diagnostic failure');
    });
    const failed = await metrics.collect();
    expect(failed).toContain('matterbridge_collection_success 0');
    expect(failed).not.toContain('matterbridge_plugin_ready{');
    expect(failed).not.toContain('matterbridge_active_subscriptions{');
    expect(failed).not.toContain('diagnostic failure');
    observe.mockReturnValue({ plugins: [], nodes: [] });
    expect(await metrics.collect()).toContain('matterbridge_collection_success 1');
  });

  test('should mark unsupported plugin diagnostics and not infer subscriptions while disconnected', async () => {
    const data = snapshot();
    data.plugins.push({ name: 'old-plugin', ready: false, exports: 0 });
    data.plugins[0].connection = { connected: false, subscribed: true, lastHeartbeatTimestampSeconds: 0 };
    metrics = new MetricsServer(() => data, log);
    const text = await metrics.collect();
    expect(text).toContain('matterbridge_plugin_connection_supported{plugin="old-plugin"} 0');
    expect(text).toContain('matterbridge_plugin_subscription_established{plugin="test-plugin"} 0');
    expect(text).not.toContain('matterbridge_plugin_connected{plugin="old-plugin"}');
  });

  test('should reject invalid nonfinite observations instead of publishing healthy data', async () => {
    const data = snapshot();
    data.plugins[0].exports = Number.NaN;
    metrics = new MetricsServer(() => data, log);
    expect(await metrics.collect()).toContain('matterbridge_collection_success 0');
  });

  test('should serve only GET metrics with the Prometheus content type', async () => {
    const port = await getFreePort();
    metrics = new MetricsServer(snapshot, log);
    expect(await metrics.start('127.0.0.1', port)).toBe(true);
    expect(await metrics.start('127.0.0.1', port)).toBe(false);
    const url = `http://127.0.0.1:${port}`;
    const response = await fetch(`${url}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('matterbridge_plugin_ready{plugin="test-plugin"} 1');
    expect((await fetch(`${url}/metrics`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${url}/api/settings`)).status).toBe(404);
    expect((await fetch(`${url}/metrics?token=secret`)).status).toBe(404);
    const responses = await Promise.all(Array.from({ length: 4 }, async () => fetch(`${url}/metrics`)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const failure = vi.spyOn(Registry.prototype, 'metrics').mockRejectedValueOnce(new Error('format failure'));
    expect((await fetch(`${url}/metrics`)).status).toBe(500);
    failure.mockRestore();
    await metrics.close();
    await expect(fetch(`${url}/metrics`)).rejects.toThrow();
  });

  test('should keep bind errors and invalid configuration isolated from the application', async () => {
    metrics = new MetricsServer(snapshot, log);
    for (const [host, port] of [
      ['localhost', 9490],
      ['127.0.0.1', 0],
      ['127.0.0.1', 65536],
    ] as const) {
      expect(await metrics.start(host, port)).toBe(false);
    }
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    try {
      expect(await metrics.start('127.0.0.1', address.port)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    expect(await metrics.collect()).toContain('matterbridge_collection_success 1');
  });
});
