/**
 * @file packages/core/src/metrics.ts
 * @description Native Prometheus listener and read-only runtime observations.
 * @author Luca Liguori
 * @created 2026-10-05
 * @version 1.0.2
 * @license Apache-2.0
 *
 * Copyright 2026, 2027, 2028 Luca Liguori.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';

import { Gauge, Registry } from '@prometheus-io/client';
import type { AnsiLogger } from 'node-ansi-logger';

/** Snapshot of one plugin's live upstream connection. No credentials or entity identifiers. */
export interface ConnectionHealth {
  connected: boolean;
  subscribed: boolean;
  lastHeartbeatTimestampSeconds: number;
}

/** Read-only observations for a configured plugin. */
export interface MetricsPlugin {
  name: string;
  ready: boolean;
  exports: number;
  connection?: ConnectionHealth;
}

/** Read-only observations for a Matter fabric and its current sessions. */
export interface MetricsFabric {
  controller: string;
  vendor?: string;
  sessions: number;
  subscriptions: number;
}

/** Read-only observations for a root, childbridge or standalone node. */
export interface MetricsNode {
  node: string;
  online: boolean;
  fabrics: MetricsFabric[];
}

/** Snapshot is produced locally without issuing requests to HA or controllers. */
export interface MetricsSnapshot {
  plugins: MetricsPlugin[];
  nodes: MetricsNode[];
}

/** Exposes an isolated Prometheus registry; instantiated only after explicit opt-in. */
export class MetricsServer {
  private server?: Server;
  private collecting?: Promise<string>;
  private readonly registry = new Registry();
  private readonly gauges = new Map<string, Gauge<string>>();

  /**
   * Create a registry without attaching timers or protocol listeners
   * @param {() => MetricsSnapshot} snapshot Read the current local runtime state.
   * @param {AnsiLogger} log Existing runtime logger.
   */
  constructor(
    private readonly snapshot: () => MetricsSnapshot,
    private readonly log: AnsiLogger,
  ) {
    this.addGauge('collection_success', 'Whether this scrape observed the runtime successfully.', []);
    this.addGauge('last_observation_timestamp_seconds', 'Unix seconds of the last successful runtime observation.', []);
    this.addGauge('uptime_seconds', 'Core process uptime in seconds.', []);
    this.addGauge('plugin_ready', 'Whether the configured plugin loaded, started and configured without error.', ['plugin']);
    this.addGauge('exports_registered', 'Registered exports for the plugin.', ['plugin']);
    this.addGauge('plugin_connection_supported', 'Whether the plugin provides native connection diagnostics.', ['plugin']);
    this.addGauge('plugin_connected', 'Whether the upstream connection is authenticated.', ['plugin']);
    this.addGauge('plugin_subscription_established', 'Whether the current upstream event subscription is acknowledged.', ['plugin']);
    this.addGauge('plugin_last_heartbeat_timestamp_seconds', 'Unix seconds of the last matching application heartbeat; zero before one is observed.', ['plugin']);
    this.addGauge('node_online', 'Whether the Matter node is online.', ['node']);
    this.addGauge('fabric_present', 'Whether this Matter fabric is registered; not proof of an active subscription.', ['node', 'controller']);
    this.addGauge('controller_info', 'Controller vendor name for a fabric alias; not a health check.', ['node', 'controller', 'vendor']);
    this.addGauge('active_sessions', 'Active Matter sessions belonging to a fabric.', ['node', 'controller']);
    this.addGauge('active_subscriptions', 'Active Matter subscriptions summed across sessions for a fabric.', ['node', 'controller']);
    this.addGauge('subscription_delivery_supported', 'Whether report acknowledgement and deadline diagnostics are supported. Zero in this release.', []);
  }

  /**
   * Bind a metrics-only HTTP listener; errors never stop household control
   * @param {string} host IP address to bind. Hostnames are deliberately unsupported.
   * @param {number} port TCP port, from 1 to 65535.
   * @returns {Promise<boolean>} True when listening, false for invalid options or bind failure.
   */
  async start(host: string, port: number): Promise<boolean> {
    if (!isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      this.log.warn('Metrics disabled: metrics_bind must be an IP address and metrics_port must be an integer from 1 to 65535');
      return false;
    }
    if (this.server) return false;
    const server = createServer((request, response) => {
      if (request.url !== '/metrics') {
        response.writeHead(404).end();
        return;
      }
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET' }).end();
        return;
      }
      void this.collect()
        .then((body) => {
          return response.writeHead(200, { 'Content-Type': this.registry.contentType, 'Cache-Control': 'no-store' }).end(body);
        })
        .catch(() => {
          response.writeHead(500).end();
        });
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1000;
    server.maxConnections = 8;
    this.server = server;
    return new Promise((resolve) => {
      server.on('error', () => {
        if (this.server === server) {
          this.log.warn('Metrics listener failed; check its bind address and port');
          this.server = undefined;
        }
        // Keep handling later errors and release the socket even after startup succeeded.
        server.close(() => {
          // Consume ERR_SERVER_NOT_RUNNING when startup failed before binding.
        });
        server.closeAllConnections();
        resolve(false);
      });
      server.listen(port, host, () => {
        resolve(true);
      });
    });
  }

  /**
   * Close only the metrics listener and release its registry
   * @returns {Promise<void>} Resolves after open listener connections are closed.
   */
  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    this.registry.clear();
  }

  /**
   * Collect a fresh snapshot and format it using the Prometheus client
   * @returns {Promise<string>} Prometheus text, including explicit collection failure on snapshot errors.
   */
  async collect(): Promise<string> {
    this.collecting ??= this.collectSnapshot().finally(() => {
      this.collecting = undefined;
    });
    return this.collecting;
  }

  /**
   * Build one coherent snapshot, shared by concurrent scrapes
   * @returns {Promise<string>} Encoded metrics.
   */
  private async collectSnapshot(): Promise<string> {
    // Clearing labeled gauges prevents disappeared sessions/plugins from looking current.
    for (const [name, gauge] of this.gauges) if (name !== 'last_observation_timestamp_seconds') gauge.reset();
    this.set('collection_success', 0);
    this.set('uptime_seconds', process.uptime());
    this.set('subscription_delivery_supported', 0);
    try {
      const snapshot = this.snapshot();
      for (const plugin of snapshot.plugins) this.collectPlugin(plugin);
      for (const node of snapshot.nodes) this.collectNode(node);
      this.set('collection_success', 1);
      this.set('last_observation_timestamp_seconds', Date.now() / 1000);
    } catch {
      // A failed observation is unknown, not a healthy empty inventory.
      for (const [name, gauge] of this.gauges)
        if (!['collection_success', 'last_observation_timestamp_seconds', 'uptime_seconds', 'subscription_delivery_supported'].includes(name)) gauge.reset();
    }
    return this.registry.metrics();
  }

  /**
   * Register one fixed metric family in this instance's registry
   * @param {string} name Metric suffix without the matterbridge prefix.
   * @param {string} help Human-readable metric semantics.
   * @param {string[]} labelNames Fixed label names.
   * @returns {void} Nothing.
   */
  private addGauge(name: string, help: string, labelNames: string[]): void {
    this.gauges.set(name, new Gauge<string>({ name: `matterbridge_${name}`, help, labelNames, registers: [this.registry] }));
  }

  /**
   * Set a known gauge, rejecting invalid observations
   * @param {string} name Registered metric suffix.
   * @param {number} value Finite numeric observation.
   * @param {Record<string, string>} labels Fixed-label values.
   * @returns {void} Nothing.
   * @throws {Error} When an observation is not finite.
   */
  private set(name: string, value: number, labels: Record<string, string> = {}): void {
    if (!Number.isFinite(value)) throw new Error('Non-finite metric observation');
    this.gauges.get(name)?.set(labels, value);
  }

  /**
   * Observe a plugin without retaining its configuration
   * @param {MetricsPlugin} plugin Safe plugin observations.
   * @returns {void} Nothing.
   */
  private collectPlugin(plugin: MetricsPlugin): void {
    const labels = { plugin: plugin.name };
    this.set('plugin_ready', Number(plugin.ready), labels);
    this.set('exports_registered', plugin.exports, labels);
    this.set('plugin_connection_supported', Number(plugin.connection !== undefined), labels);
    if (!plugin.connection) return;
    this.set('plugin_connected', Number(plugin.connection.connected), labels);
    this.set('plugin_subscription_established', Number(plugin.connection.connected && plugin.connection.subscribed), labels);
    this.set('plugin_last_heartbeat_timestamp_seconds', plugin.connection.lastHeartbeatTimestampSeconds, labels);
  }

  /**
   * Observe registered fabrics, including those with no active session
   * @param {MetricsNode} node Safe node observations.
   * @returns {void} Nothing.
   */
  private collectNode(node: MetricsNode): void {
    this.set('node_online', Number(node.online), { node: node.node });
    for (const fabric of node.fabrics) {
      const labels = { node: node.node, controller: fabric.controller };
      this.set('fabric_present', 1, labels);
      this.set('controller_info', 1, { ...labels, vendor: fabric.vendor ?? 'unknown' });
      this.set('active_sessions', fabric.sessions, labels);
      this.set('active_subscriptions', fabric.subscriptions, labels);
    }
  }
}
