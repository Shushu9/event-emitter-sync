import { EventEmitter } from "./emitter";
import { EventDelayedRepository } from "./event-repository";
import { EventStatistics } from "./event-statistics";
import { ResultsTester } from "./results-tester";
import { triggerRandomly } from "./utils";

const MAX_EVENTS = 1000;

enum EventName {
  EventA = "A",
  EventB = "B",
}

const EVENT_NAMES = [EventName.EventA, EventName.EventB];

function init() {
  const emitter = new EventEmitter<EventName>();

  // Триггеры для случайной генерации событий
  triggerRandomly(() => emitter.emit(EventName.EventA), MAX_EVENTS);
  triggerRandomly(() => emitter.emit(EventName.EventB), MAX_EVENTS);

  const repository = new EventRepository();
  const handler = new EventHandler(emitter, repository);

  // Тестирование результатов с выводом статистики
  const resultsTester = new ResultsTester({
    eventNames: EVENT_NAMES,
    emitter,
    handler,
    repository,
  });
  resultsTester.showStats(20);
}

enum EventRepositoryError {
  TOO_MANY = "Too many requests",
  RESPONSE_FAIL = "Response delivery fail",
  REQUEST_FAIL = "Request fail",
}

interface RetryEvent {
  eventName: EventName;
  count: number;
  attempt: number;
}

interface EventPriority {
  eventName: EventName;
  count: number;
  failedAttempts: number;
}

const BATCH_INTERVAL_MS = 300;
const EVENT_SAVE_DELAY_MS = 300;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_MAX_DELAY_MS = 300;
const FORCE_SYNC_THRESHOLD = 10;
const SYNC_INTERVAL_LIMIT_MS = 300;

export class EventHandler extends EventStatistics<EventName> {
  private repository: EventRepository;

  constructor(emitter: EventEmitter<EventName>, repository: EventRepository) {
    super();
    this.repository = repository;

    // Подписка на все события
    EVENT_NAMES.forEach((eventName) => {
      emitter.subscribe(eventName, () => this.handleEvent(eventName));
    });
  }

  // Обработка события: обновление статистики и отправка в репозиторий
  private handleEvent(eventName: EventName) {
    this.incrementStat(eventName);
    this.repository.enqueueEvent(eventName, 1);
  }

  // Увеличение счётчика локальной статистики
  private incrementStat(eventName: EventName) {
    const currentCount = this.getStats(eventName) || 0;
    this.setStats(eventName, currentCount + 1);
  }
}

export class EventRepository extends EventDelayedRepository<EventName> {
  private eventQueue: Map<EventName, number> = new Map();
  private isProcessing: boolean = false;
  private retryQueue: Map<EventName, RetryEvent> = new Map();
  private lastSyncTime: number = 0;
  private syncScheduled: boolean = false;
  private failedAttemptsMap: Map<EventName, number> = new Map();
  private lastForcedSyncTime: number = 0;

  constructor() {
    super();
    // Периодическая обработка очереди
    setInterval(() => this.processQueue(), BATCH_INTERVAL_MS);
  }

  // Добавление события в очередь для пакетной обработки
  enqueueEvent(eventName: EventName, count: number) {
    const currentCount = this.eventQueue.get(eventName) || 0;
    this.eventQueue.set(eventName, currentCount + count);

    // Проверка условия для принудительной синхронизации
    if (
      this.getQueueCountForEvent(eventName) >= FORCE_SYNC_THRESHOLD &&
      !this.isProcessing &&
      !this.syncScheduled
    ) {
      const now = Date.now();
      const timeSinceLastSync = now - this.lastSyncTime;
      const timeSinceLastForcedSync = now - this.lastForcedSyncTime;

      if (
        timeSinceLastSync >= SYNC_INTERVAL_LIMIT_MS &&
        timeSinceLastForcedSync >= 1000
      ) {
        this.lastForcedSyncTime = now;
        this.processQueue();
      } else {
        const delay = SYNC_INTERVAL_LIMIT_MS - timeSinceLastSync;
        this.syncScheduled = true;
        setTimeout(() => {
          this.syncScheduled = false;
          this.processQueue();
        }, delay);
      }
    }
  }

  // Обработка очереди событий с ретрайем и приоритизацией
  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.lastSyncTime = Date.now();

    try {
      const currentBatch = new Map(this.eventQueue);
      this.eventQueue.clear();

      // Добавление событий из очереди ретраев
      this.retryQueue.forEach((retryEvent) => {
        const existingCount = currentBatch.get(retryEvent.eventName) || 0;
        currentBatch.set(
          retryEvent.eventName,
          existingCount + retryEvent.count
        );
      });
      this.retryQueue.clear();

      if (currentBatch.size === 0) {
        this.isProcessing = false;
        return;
      }

      // Приоритизация событий на основе количества неудачных попыток и количества событий
      const prioritizedEvents: EventPriority[] = Array.from(
        currentBatch.entries()
      ).map(([eventName, count]) => ({
        eventName,
        count,
        failedAttempts: this.failedAttemptsMap.get(eventName) || 0,
      }));

      prioritizedEvents.sort(
        (a, b) => b.failedAttempts - a.failedAttempts || b.count - a.count
      );

      // Обработка событий в приоритетном порядке
      for (const event of prioritizedEvents) {
        const { eventName, count } = event;
        try {
          await this.updateEventStatsBy(eventName, count);
          this.failedAttemptsMap.set(eventName, 0);
        } catch (error) {
          await this.handleError(
            eventName,
            count,
            error as EventRepositoryError,
            1
          );
        }

        // Задержка между синхронизациями разных событий
        await this.delay(EVENT_SAVE_DELAY_MS);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  // Обработка ошибок во время синхронизации и управление ретраями
  private async handleError(
    eventName: EventName,
    count: number,
    error: EventRepositoryError,
    attempt: number
  ) {
    switch (error) {
      case EventRepositoryError.TOO_MANY:
        if (attempt <= MAX_ATTEMPTS) {
          const delayMs = this.calculateRetryDelay(attempt, true);
          this.failedAttemptsMap.set(
            eventName,
            (this.failedAttemptsMap.get(eventName) || 0) + 1
          );
          setTimeout(() => {
            this.retryQueue.set(eventName, {
              eventName,
              count,
              attempt: attempt + 1,
            });
            this.processQueue();
          }, delayMs);
        } else {
          this.failedAttemptsMap.set(eventName, 0);
        }
        break;

      case EventRepositoryError.REQUEST_FAIL:
        if (attempt <= MAX_ATTEMPTS) {
          const delayMs = this.calculateRetryDelay(attempt, false);
          this.failedAttemptsMap.set(
            eventName,
            (this.failedAttemptsMap.get(eventName) || 0) + 1
          );
          setTimeout(() => {
            this.retryQueue.set(eventName, {
              eventName,
              count,
              attempt: attempt + 1,
            });
            this.processQueue();
          }, delayMs);
        } else {
          this.failedAttemptsMap.set(eventName, 0);
        }
        break;

      case EventRepositoryError.RESPONSE_FAIL:
        this.failedAttemptsMap.set(eventName, 0);
        break;

      default:
        this.failedAttemptsMap.set(eventName, 0);
    }
  }

  // Рассчёт задержки для ретрая с экспоненциальным бэк-оффом и джиттером
  private calculateRetryDelay(
    attempt: number,
    isTooManyRequests: boolean
  ): number {
    const baseDelay = isTooManyRequests
      ? RETRY_BASE_DELAY_MS * 2
      : RETRY_BASE_DELAY_MS;
    const delay = Math.min(baseDelay * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    const jitter = Math.random() * 200;
    return delay + jitter;
  }

  // Асинхронная задержка
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Получение количества событий для определённого типа
  private getQueueCountForEvent(eventName: EventName): number {
    return this.eventQueue.get(eventName) || 0;
  }
}

init();
