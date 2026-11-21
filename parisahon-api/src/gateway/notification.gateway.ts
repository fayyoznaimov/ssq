import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';

import { Server, Socket } from 'socket.io';
import { AuthGuard, AuthUser } from '../auth/auth.guard';
import { RoleEnum } from '../user/user.entity';

interface AuthenticatedSocket extends Socket {
  user?: AuthUser;
}

// setTimeout() cannot wait longer than this
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Realtime notifications.
 *
 * Authentication: a socket.io middleware (see afterInit) verifies the JWT of
 * every handshake with the same code as the HTTP guard (signature, expiry,
 * the account still exists and is a staff account). A handshake without a
 * valid token is refused with connect_error "Unauthorized" and never becomes
 * a connection. The token is taken from `auth: { token }` (what the frontend
 * sends) or from the Authorization header, with or without "Bearer ".
 * The socket is closed when its token expires.
 *
 * Delivery: nothing is broadcast to everybody any more. Each socket joins
 *   user:<id>, role:<role> and group:<group id>
 * and a notification goes only to the rooms it concerns (see sendNotification).
 *
 * Payload: a whitelisted summary, never the entity that the caller passed in
 * (TaskService passes JSON.stringify(savedTask) with nested user objects).
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class NotificationGateWay
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(private authGuard: AuthGuard) { }

  private logger: Logger = new Logger('NotificationGateWay');
  private expiryTimers = new WeakMap<Socket, NodeJS.Timeout>();

  afterInit(server: Server) {
    server.use(async (socket: AuthenticatedSocket, next) => {
      try {
        socket.user = await this.authGuard.authenticate(
          AuthGuard.extractSocketToken(socket.handshake),
        );
        next();
      } catch {
        next(new Error('Unauthorized'));
      }
    });

    this.logger.log('WebSocket Initialized');
  }

  handleConnection(client: AuthenticatedSocket) {
    const user = client.user;

    // Cannot happen with the middleware in place; kept as a safety net
    if (!user) {
      client.disconnect(true);
      return;
    }

    const rooms = [`user:${user.sub}`, `role:${user.role}`];
    if (user.group_id) {
      rooms.push(`group:${user.group_id}`);
    }
    client.join(rooms);

    if (user.exp) {
      const msLeft = user.exp * 1000 - Date.now();
      this.expiryTimers.set(
        client,
        setTimeout(
          () => client.disconnect(true),
          Math.min(Math.max(msLeft, 0), MAX_TIMER_MS),
        ),
      );
    }

    this.logger.log(`Client connected: ${client.id}, user ${user.sub}`);
  }

  handleDisconnect(client: Socket) {
    clearTimeout(this.expiryTimers.get(client));
    this.expiryTimers.delete(client);
    this.logger.log(`Client disconnected with id ${client.id}`);
  }

  /**
   * Called by TaskService with JSON.stringify(savedTask).
   *
   * Recipients: the assignee (task.agent) and the members of the assigned
   * group (task.group), plus admin and manager who supervise all tasks.
   * A task with neither goes to every connected staff user.
   *
   * The event data stays a JSON string, as before.
   */
  sendNotification(data: any) {
    const task = this.parse(data);

    const rooms = [`role:${RoleEnum.ADMIN}`, `role:${RoleEnum.MANAGER}`];
    const agentId = this.idOf(task?.agent);
    const groupId = this.idOf(task?.group);

    if (agentId) rooms.push(`user:${agentId}`);
    if (groupId) rooms.push(`group:${groupId}`);
    if (!agentId && !groupId) rooms.push(`role:${RoleEnum.AGENT}`);

    this.server
      .to(rooms)
      .emit('notification', JSON.stringify(this.toPublicPayload(task)));
  }

  // The global AuthGuard also covers gateway message handlers
  @SubscribeMessage('message')
  handleMessage(client: Socket, payload: any) {
    this.logger.log(`Received message from client with id ${client.id}`);
    return payload;
  }

  private parse(data: any): Record<string, any> | null {
    if (typeof data !== 'string') {
      return data && typeof data === 'object' ? data : null;
    }

    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  private idOf(entity: any): number | null {
    const id = Number(entity?.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  private named(entity: any, nameField: string) {
    const id = this.idOf(entity);
    return id ? { id, [nameField]: entity[nameField] ?? null } : null;
  }

  /**
   * Only these fields leave the server. Users are reduced to id + username,
   * so password hashes, Telegram credentials, permissions, phones and emails
   * of the nested user objects can never be sent out.
   */
  private toPublicPayload(task: Record<string, any> | null) {
    if (!task) {
      return { kind: 'task' };
    }

    return {
      kind: 'task',
      id: this.idOf(task),
      label: task.label ?? null,
      start_time: task.start_time ?? null,
      end_time: task.end_time ?? null,
      type: this.named(task.type, 'name'),
      agent: this.named(task.agent, 'username'),
      group: this.named(task.group, 'name'),
      created_by: this.named(task.created_by, 'username'),
      deal_id: this.idOf(task.deal),
      company_id: this.idOf(task.company),
      ctr_agent_id: this.idOf(task.ctr_agent),
    };
  }
}
