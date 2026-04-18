import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../../src/state/EventStore.js';

describe('EventStore.pushEvent', () => {
  it('adds an event with derived phone', () => {
    const store = new EventStore();
    const event = store.pushEvent({
      source: 'test',
      isFromMe: false,
      chatJid: '5599887766@c.us',
      text: 'hello',
      payload: { id: '', timestamp: 0 }
    });
    assert.ok(event);
    assert.equal(event.chatJid, '5599887766@c.us');
    assert.equal(event.phone, '5599887766');
    assert.equal(event.text, 'hello');
    assert.equal(event.isFromMe, false);
    assert.equal(typeof event.id, 'string');
    assert.ok(event.id.length > 0);
    assert.equal(typeof event.receivedAt, 'string');
    assert.equal(store.events.length, 1);
  });

  it('deduplicates events by id', () => {
    const store = new EventStore();
    const first = store.pushEvent({
      id: 'stable-id',
      source: 'test',
      isFromMe: false,
      chatJid: '5511@c.us',
      text: 'a',
      payload: { id: 'stable-id', timestamp: 0 }
    });
    assert.ok(first);
    const dup = store.pushEvent({
      id: 'stable-id',
      source: 'test',
      isFromMe: false,
      chatJid: '5511@c.us',
      text: 'b',
      payload: { id: 'stable-id', timestamp: 0 }
    });
    assert.equal(dup, null);
    assert.equal(store.events.length, 1);
  });

  it('invokes the onEventPushed listener', () => {
    const store = new EventStore();
    const received: string[] = [];
    store.setOnEventPushed(event => {
      received.push(event.chatJid);
    });
    store.pushEvent({
      source: 'test',
      isFromMe: false,
      chatJid: '5511@c.us',
      payload: { id: '', timestamp: 0 }
    });
    assert.deepEqual(received, ['5511@c.us']);
  });

  it('keeps at most MAX_EVENTS (200) entries', () => {
    const store = new EventStore();
    for (let i = 0; i < 220; i++) {
      store.pushEvent({
        id: `event-${i}`,
        source: 'test',
        isFromMe: false,
        chatJid: '5511@c.us',
        payload: { id: `event-${i}`, timestamp: i }
      });
    }
    assert.equal(store.events.length, 200);
  });
});

describe('EventStore.trackEventId', () => {
  it('is idempotent for the same id', () => {
    const store = new EventStore();
    store.trackEventId('abc');
    store.trackEventId('abc');

    const first = store.pushEvent({
      id: 'abc',
      source: 'test',
      isFromMe: false,
      chatJid: '5511@c.us',
      payload: { id: 'abc', timestamp: 0 }
    });
    assert.equal(first, null);
  });

  it('ignores empty or null ids', () => {
    const store = new EventStore();
    store.trackEventId('');
    store.trackEventId(null);
    assert.equal(store.events.length, 0);
  });
});

describe('EventStore.updateEventAck', () => {
  it('updates ack on existing event and payload', () => {
    const store = new EventStore();
    const event = store.pushEvent({
      id: 'msg-1',
      source: 'send-api',
      isFromMe: true,
      chatJid: '5511@c.us',
      payload: { id: 'msg-1', timestamp: 0, ack: 0 }
    });
    assert.ok(event);
    store.updateEventAck('msg-1', 3);
    assert.equal(store.getEventAck('msg-1'), 3);
    assert.equal(event.ack, 3);
    assert.equal(event.payload.ack, 3);
  });

  it('ignores missing id', () => {
    const store = new EventStore();
    store.updateEventAck('', 2);
    store.updateEventAck(null, 2);
    assert.equal(store.events.length, 0);
  });
});

describe('EventStore.getEventChatJid', () => {
  it('returns chatJid for known message id', () => {
    const store = new EventStore();
    store.pushEvent({
      id: 'msg-7',
      source: 'test',
      isFromMe: true,
      chatJid: '5511@c.us',
      payload: { id: 'msg-7', timestamp: 0 }
    });
    assert.equal(store.getEventChatJid('msg-7'), '5511@c.us');
  });

  it('returns null for unknown id', () => {
    const store = new EventStore();
    assert.equal(store.getEventChatJid('nope'), null);
  });
});
