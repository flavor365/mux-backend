import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import { WebhookEndpoint, EndpointStatus } from './domain/webhook-events';
import * as crypto from 'crypto';

export interface CreateWebhookEndpointRequest {
  projectId: string;
  url: string;
  events: string[];
  description?: string;
}

export interface UpdateWebhookEndpointRequest {
  url?: string;
  events?: string[];
  description?: string;
  status?: string;
}

export interface RotateSecretResult {
  /** The new primary secret — store this immediately. */
  secret: string;
  /**
   * The old secret is still accepted as a fallback until
   * `pendingSecretExpiresAt`.  Update your consumers before this time.
   */
  pendingSecretExpiresAt: Date;
  /** Window duration in seconds. */
  windowSeconds: number;
}

/**
 * Webhook Management Service
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private prisma: PrismaClient;
  /** Duration of the dual-secret overlap window in seconds. */
  private readonly secretRotationWindowSeconds: number;

  constructor(private readonly configService: ConfigService) {
    this.prisma = new PrismaClient({} as any);
    this.secretRotationWindowSeconds = this.configService.get<number>(
      'WEBHOOK_SECRET_ROTATION_WINDOW_SECONDS',
      86400, // default: 24 hours
    );
  }

  /**
   * Creates a new webhook endpoint
   */
  async createEndpoint(
    request: CreateWebhookEndpointRequest,
  ): Promise<WebhookEndpoint> {
    this.logger.log(
      `Creating webhook endpoint for project ${request.projectId}`,
    );

    // Generate secret for signing
    const secret = this.generateSecret();

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        projectId: request.projectId,
        url: request.url,
        events: request.events,
        description: request.description,
        secret,
        status: EndpointStatus.ACTIVE,
      },
    });

    this.logger.log(`Created webhook endpoint ${endpoint.id}`);
    return this.mapPrismaEndpointToDomain(endpoint);
  }

  /**
   * Lists webhook endpoints for a project
   */
  async listEndpoints(projectId: string): Promise<WebhookEndpoint[]> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });

    return endpoints.map((e) => this.mapPrismaEndpointToDomain(e));
  }

  /**
   * Gets a webhook endpoint by ID
   */
  async getEndpoint(endpointId: string): Promise<WebhookEndpoint> {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: endpointId },
    });

    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint ${endpointId} not found`);
    }

    return this.mapPrismaEndpointToDomain(endpoint);
  }

  /**
   * Updates a webhook endpoint
   */
  async updateEndpoint(
    endpointId: string,
    updates: UpdateWebhookEndpointRequest,
  ): Promise<WebhookEndpoint> {
    const endpoint = await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: updates,
    });

    this.logger.log(`Updated webhook endpoint ${endpointId}`);
    return this.mapPrismaEndpointToDomain(endpoint);
  }

  /**
   * Deletes a webhook endpoint
   */
  async deleteEndpoint(endpointId: string): Promise<void> {
    await this.prisma.webhookEndpoint.delete({
      where: { id: endpointId },
    });

    this.logger.log(`Deleted webhook endpoint ${endpointId}`);
  }

  /**
   * Rotates the webhook signing secret with a dual-secret overlap window.
   *
   * The old secret is stored as `pendingSecret` and remains valid until
   * `pendingSecretExpiresAt`.  Consumers have until that deadline to update
   * their verification logic.  After the deadline only the new `secret` is
   * accepted.
   *
   * The window duration is controlled by the
   * `WEBHOOK_SECRET_ROTATION_WINDOW_SECONDS` environment variable
   * (default: 86400 = 24 hours).
   */
  async rotateSecret(endpointId: string): Promise<RotateSecretResult> {
    const existing = await this.prisma.webhookEndpoint.findUnique({
      where: { id: endpointId },
    });

    if (!existing) {
      throw new NotFoundException(`Webhook endpoint ${endpointId} not found`);
    }

    const newSecret = this.generateSecret();
    const pendingSecretExpiresAt = new Date(
      Date.now() + this.secretRotationWindowSeconds * 1000,
    );

    // The current active secret becomes `pendingSecret` (the fallback).
    // The freshly generated secret becomes the new primary `secret`.
    await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: {
        secret: newSecret,
        pendingSecret: existing.secret,
        pendingSecretExpiresAt,
      },
    });

    this.logger.log(
      `Rotated secret for webhook endpoint ${endpointId}. ` +
        `Old secret valid as fallback until ${pendingSecretExpiresAt.toISOString()}.`,
    );

    return {
      secret: newSecret,
      pendingSecretExpiresAt,
      windowSeconds: this.secretRotationWindowSeconds,
    };
  }

  /**
   * Gets delivery attempts for an endpoint
   */
  async getDeliveries(endpointId: string, limit: number = 50) {
    return await this.prisma.webhookDelivery.findMany({
      where: { endpointId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Generates a secure random secret
   */
  private generateSecret(): string {
    return `whsec_${crypto.randomBytes(32).toString('base64url')}`;
  }

  /**
   * Maps Prisma endpoint to domain model
   */
  private mapPrismaEndpointToDomain(prismaEndpoint: any): WebhookEndpoint {
    return {
      id: prismaEndpoint.id,
      projectId: prismaEndpoint.projectId,
      url: prismaEndpoint.url,
      description: prismaEndpoint.description,
      secret: prismaEndpoint.secret,
      pendingSecret: prismaEndpoint.pendingSecret ?? null,
      pendingSecretExpiresAt: prismaEndpoint.pendingSecretExpiresAt ?? null,
      events: prismaEndpoint.events,
      status: prismaEndpoint.status,
      consecutiveFailures: prismaEndpoint.consecutiveFailures,
      lastFailureAt: prismaEndpoint.lastFailureAt,
      lastFailureReason: prismaEndpoint.lastFailureReason,
      lastSuccessAt: prismaEndpoint.lastSuccessAt,
      createdAt: prismaEndpoint.createdAt,
      updatedAt: prismaEndpoint.updatedAt,
    };
  }
}
