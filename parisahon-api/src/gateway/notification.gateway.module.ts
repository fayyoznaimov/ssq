import { Module } from '@nestjs/common';
import { NotificationGateWay } from './notification.gateway';
import { JwtModule } from '@nestjs/jwt';
import { AuthGuard } from '../auth/auth.guard';
import { LiveUpdatesSubscriber } from './live-updates.subscriber';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '24h' },
    }),
  ],
  // AuthGuard: the gateway authenticates handshakes with AuthGuard.authenticate()
  providers: [NotificationGateWay, AuthGuard, LiveUpdatesSubscriber],
  exports: [NotificationGateWay],
})
export class NotificationGateWayModule {}
