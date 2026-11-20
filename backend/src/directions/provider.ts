import {
  BadGatewayException, HttpException, HttpStatus, ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';

export function coordinate(limit: number) {
  return z.string().trim().regex(/^-?\d+(?:\.\d+)?$/)
    .refine(value => Math.abs(Number(value)) <= limit);
}

export type GeoPoint = [longitude: number, latitude: number];
export type Place = { name: string; detail: string; point: GeoPoint };
export type Endpoints = { start_x: string; start_y: string; end_x: string; end_y: string };
export type RouteMode = 'walk' | 'transit';
export type RouteStep = {
  properties: {
    type: string; guidance?: string; distance?: number;
    stops?: { name: string; point?: GeoPoint }[]; vehicles?: { name: string }[];
  };
  path: { points: GeoPoint[] };
};
export type RouteSummary = { totalTime?: number; totalDistance?: number; transfers?: number; fare?: { value: number } };
export type RouteResult = {
  status: string;
  route?: { properties?: RouteSummary; legs: { steps: RouteStep[] }[] };
  routes?: { properties?: RouteSummary; steps: RouteStep[] }[];
};

export interface DirectionsProvider {
  readonly id: 'kakao' | 'tmap';
  searchPlaces(query: string): Promise<Place[]>;
  findRoute(mode: RouteMode, endpoints: Endpoints): Promise<RouteResult>;
}

export class TemporaryProviderError extends HttpException {}

export async function requestJson(url: URL, options: RequestInit): Promise<{ status: number; body: unknown }> {
  const signal = AbortSignal.timeout(10_000);
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal });
    if (response.status === 204) return { status: 204, body: null };
    const body: unknown = response.ok ? await response.json() : await response.json().catch(() => null);
    return { status: response.status, body };
  } catch (error) {
    if (signal.aborted) throw new TemporaryProviderError('Directions provider request timed out', HttpStatus.GATEWAY_TIMEOUT);
    if (error instanceof SyntaxError) throw new BadGatewayException('Could not read the directions provider response');
    throw new TemporaryProviderError('Could not read the directions provider response', HttpStatus.BAD_GATEWAY);
  }
}

export function providerError(status: number) {
  if (status === 429) return new TemporaryProviderError('Directions provider request limit reached', HttpStatus.TOO_MANY_REQUESTS);
  if (status >= 500) return new TemporaryProviderError('Directions provider could not process the request', HttpStatus.BAD_GATEWAY);
  if (status === 401 || status === 403) {
    return new ServiceUnavailableException('Check the directions provider API key and product permissions');
  }
  return new BadGatewayException('Directions provider could not process the request');
}
