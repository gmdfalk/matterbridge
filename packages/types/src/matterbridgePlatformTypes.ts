/**
 * @file packages/types/src/matterbridgePlatformTypes.ts
 * @description This file contains the types for MatterbridgePlatform.
 * @author Luca Liguori
 * @created 2024-03-21
 * @version 1.7.1
 * @license Apache-2.0
 *
 * Copyright 2024, 2025, 2026 Luca Liguori.
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

// @matter
import type { VendorId } from '@matter/types/datatype';

// Matterbridge
import type { BridgeMode, RestartMode, SystemInformation, VirtualMode } from './matterbridgeTypes.js';

/** Platform configuration value type. */
export type PlatformConfigValue = string | number | boolean | bigint | object | undefined | null;

/** Platform configuration type. */
export type BasePlatformConfig = { name: string; type: string; version: string; debug: boolean; unregisterOnShutdown: boolean };

/** Platform configuration type. */
export type PlatformConfig = BasePlatformConfig & Record<string, PlatformConfigValue>;

/** Platform schema value type. */
export type PlatformSchemaValue = string | number | boolean | bigint | object | undefined | null;

/** Platform schema type. */
export type PlatformSchema = Record<string, PlatformSchemaValue>;

/** A type representing a subset of readonly properties of Matterbridge for platform use. */
export type PlatformMatterbridge = {
  /** Whether core can serve native metrics for an opted-in plugin. */
  readonly supportsNativeMetrics?: boolean;
  readonly systemInformation: Readonly<
    Pick<
      SystemInformation,
      | 'interfaceName'
      | 'macAddress'
      | 'ipv4Address'
      | 'ipv6Address'
      | 'nodeVersion'
      | 'hostname'
      | 'user'
      | 'osType'
      | 'osRelease'
      | 'osPlatform'
      | 'osArch'
      | 'totalMemory'
      | 'freeMemory'
      | 'constrainedMemory'
      | 'systemUptime'
      | 'processUptime'
      | 'cpuUsage'
      | 'processCpuUsage'
      | 'rss'
      | 'heapTotal'
      | 'heapUsed'
    >
  >;
  readonly uuid: string;
  readonly rootDirectory: string;
  readonly homeDirectory: string;
  readonly matterbridgeDirectory: string;
  readonly matterbridgePluginDirectory: string;
  readonly matterbridgeCertDirectory: string;
  readonly globalModulesDirectory: string;
  readonly matterbridgeVersion: string;
  readonly matterbridgeLatestVersion: string;
  readonly matterbridgeDevVersion: string;
  readonly frontendVersion: string;
  readonly bridgeMode: BridgeMode;
  readonly restartMode: RestartMode;
  readonly virtualMode: VirtualMode;
  readonly aggregatorVendorId: VendorId;
  readonly aggregatorVendorName: string;
  readonly aggregatorProductId: number;
  readonly aggregatorProductName: string;
};

/** Read-only health of a plugin's upstream connection, returned only when metrics are enabled. */
export interface PlatformConnectionHealth {
  /** Whether the current upstream connection is authenticated. */
  connected: boolean;
  /** Whether the current connection has an acknowledged event subscription. */
  subscribed: boolean;
  /** Unix seconds of the last matching application heartbeat, or zero if none. */
  lastHeartbeatTimestampSeconds: number;
}
