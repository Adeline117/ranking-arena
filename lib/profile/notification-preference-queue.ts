import type { NotificationPreferenceField } from './notification-preferences'
import {
  LatestWriteQueue,
  type LatestWriteQueueOptions,
  type LatestWriteResult,
} from './latest-write-queue'

export type NotificationPreferenceWriteResult = LatestWriteResult

type NotificationPreferenceQueueOptions<Context> = LatestWriteQueueOptions<
  NotificationPreferenceField,
  boolean,
  Context
>

/**
 * Serializes writes per preference while retaining only the latest desired
 * value. This prevents out-of-order HTTP responses from making the database
 * disagree with the toggle shown to the user.
 */
export class NotificationPreferenceQueue<Context> extends LatestWriteQueue<
  NotificationPreferenceField,
  boolean,
  Context
> {
  constructor(options: NotificationPreferenceQueueOptions<Context>) {
    super(options)
  }
}
