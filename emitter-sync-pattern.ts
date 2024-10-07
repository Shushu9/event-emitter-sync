/* Check the comments first */

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

/*

  An initial configuration for this case

*/

function init() {
  const emitter = new EventEmitter<EventName>();

  triggerRandomly(() => emitter.emit(EventName.EventA), MAX_EVENTS);
  triggerRandomly(() => emitter.emit(EventName.EventB), MAX_EVENTS);

  const repository = new EventRepository();
  const handler = new EventHandler(emitter, repository);

  const resultsTester = new ResultsTester({
    eventNames: EVENT_NAMES,
    emitter,
    handler,
    repository,
  });
  resultsTester.showStats(20);
}

/* Please do not change the code above this line */
/* ----–––––––––––––––––––––––––––––––––––––---- */

/*

  The implementation of EventHandler and EventRepository is up to you.
  Main idea is to subscribe to EventEmitter, save it in local stats
  along with syncing with EventRepository.

  The implementation of EventHandler and EventRepository is flexible and left to your discretion.
  The primary objective is to subscribe to EventEmitter, record the events in `.eventStats`,
  and ensure synchronization with EventRepository.

  The ultimate aim is to have the `.eventStats` of EventHandler and EventRepository
  have the same values (and equal to the actual events fired by the emitter) by the
  time MAX_EVENTS have been fired.

*/

class EventHandler extends EventStatistics<EventName> {
  // Feel free to edit this class

  repository: EventRepository;
  accumulatedEvents: Map<EventName, number>;
  syncStarted = false;

  constructor(emitter: EventEmitter<EventName>, repository: EventRepository) {
    super();
    this.repository = repository;
    this.accumulatedEvents = new Map<EventName, number>();

    emitter.subscribe(EventName.EventA, () =>
      this.handleEvent(EventName.EventA)
    );

    emitter.subscribe(EventName.EventB, () =>
      this.handleEvent(EventName.EventB)
    );

  }

  async handleEvent(eventName: EventName) {
    this.setStats(eventName, this.getStats(eventName) + 1);
    this.accumulateEvent(eventName);
    if (!this.syncStarted) {
      this.syncStarted = true;
      this.syncEvents()
      setInterval(() => this.syncEvents(), 1000) // test fires every 1000 sec.
    }
  }

  accumulateEvent(eventName: EventName) {
    this.accumulatedEvents.set(eventName, (this.accumulatedEvents.get(eventName) || 0) + 1)
  }

  async syncEvents() {
    for (const [eventName, count] of this.accumulatedEvents.entries()) {
      try {
        await this.repository.saveEventData(eventName, count);
        this.accumulatedEvents.set(eventName, 0);
      } catch (e) {
        // console.log(e, 'error');
      }
    }
  }
}

enum EventRepositoryError {
  TOO_MANY = "Too many requests",
  RESPONSE_FAIL = "Response delivery fail",
  REQUEST_FAIL = "Request fail",
}

class EventRepository extends EventDelayedRepository<EventName> {
  // Feel free to edit this class

  counter = 0;

  async saveEventData(eventName: EventName, count: number) {
    let attempt = 0;
    this.counter += count;

    while (attempt < 5) {
      try {
        await this.updateEventStatsBy(eventName, this.counter);
        this.counter = 0;
        return;
      } catch (e) {
        attempt++;

        if (e == EventRepositoryError.RESPONSE_FAIL) {
          return;
        } else if (attempt > 5) {
          throw e;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 200))
          // console.log('attemp failed');
        }
      }
    }
  }
}

init();
