import orderBy from 'lodash/orderBy'

class Event {
  constructor(data, { accessors, slotMetrics }) {
    const {
      start,
      startDate,
      end,
      endDate,
      top,
      height,
    } = slotMetrics.getRange(accessors.start(data), accessors.end(data))

    this.start = start
    this.end = end
    this.startMs = +startDate
    this.endMs = +endDate
    this.top = top
    this.height = height
    this.data = data
  }

  /**
   * The event's width without any overlap.
   */
  get _width() {
    if (this.data.width) {
      return this.data.width
    }

    // The container event's width is determined by the maximum number of
    // events in any of its rows.
    if (this.rows) {
      const columns =
        this.rows.reduce(
          (max, row) => Math.max(max, row.leaves.length + 1), // add itself
          0
        ) + 1 // add the container

      return { value: 100 / columns, unit: '%' }
    }

    const availableWidth = 100 - this.container._width.value

    // The row event's width is the space left by the container, divided
    // among itself and its leaves.
    if (this.leaves) {
      return { value: availableWidth / (this.leaves.length + 1), unit: '%' }
    }

    // The leaf event's width is determined by its row's width
    return this.row._width
  }

  /**
   * The event's calculated width, possibly with extra width added for
   * overlapping effect.
   */
  get width() {
    const noOverlap = this._width
    if (noOverlap.unit !== '%') return noOverlap

    const overlap = {
      value: Math.min(100, noOverlap.value * 1.7),
      unit: noOverlap.unit,
    }

    // Containers can always grow.
    if (this.rows) {
      return overlap
    }

    // Rows can grow if they have leaves.
    if (this.leaves) {
      return this.leaves.length > 0 ? overlap : noOverlap
    }

    // Leaves can grow unless they're the last item in a row.
    const { leaves } = this.row
    const index = leaves.indexOf(this)
    return index === leaves.length - 1 ? noOverlap : overlap
  }

  get xOffset() {
    // Containers have no offset.
    if (this.rows) return { value: 0, unit: '' }

    const padding = 2
    if (this.column >= 0)
      return {
        value: (this._width.value + padding) * this.column,
        unit: this._width.unit,
      }

    // Rows always start where their container ends.
    if (this.leaves) {
      const containerWidth = this.container._width
      // if px value, add padding
      if (containerWidth.unit === 'px') {
        return {
          value: containerWidth.value + padding,
          unit: containerWidth.unit,
        }
      }
      return this.container._width
    }

    // Leaves are spread out evenly on the space left by its row.
    const { leaves, xOffset, _width } = this.row
    const offset =
      _width.unit === 'px' ? xOffset.value + padding : xOffset.value

    const index = leaves.indexOf(this) + 1
    return { value: offset + index * _width.value, unit: _width.unit }
  }

  get eventType() {
    if (this.data && this.data.eventType) return this.data.eventType
    return null
  }
}

/**
 * Return true if event a and b is considered to be on the same row.
 */
function onSameRow(a, b, minimumStartDifference) {
  return (
    // Occupies the same start slot.
    Math.abs(b.start - a.start) < minimumStartDifference ||
    // A's start slot overlaps with b's end slot.
    (b.start > a.start && b.start < a.end)
  )
}

function sortByRender(events) {
  const sortedByTime = orderBy(
    events,
    ['eventType', 'startMs', e => -e.endMs],
    ['desc', 'asc', 'asc']
  )

  const sorted = []
  while (sortedByTime.length > 0) {
    const event = sortedByTime.shift()
    sorted.push(event)
    if (event.eventType) continue

    for (let i = 0; i < sortedByTime.length; i++) {
      const test = sortedByTime[i]

      // Still inside this event, look for next.
      if (event.endMs > test.startMs) continue

      if (test.eventType) break

      // We've found the first event of the next event group.
      // If that event is not right next to our current event, we have to
      // move it here.
      if (i > 0) {
        const event = sortedByTime.splice(i, 1)[0]
        sorted.push(event)
      }

      // We've already found the next event group, so stop looking.
      break
    }
  }

  return sorted
}

function getStyledEvents({
  events,
  minimumStartDifference,
  slotMetrics,
  accessors,
}) {
  // Create proxy events and order them so that we don't have
  // to fiddle with z-indexes.
  const proxies = events.map(
    event => new Event(event, { slotMetrics, accessors })
  )
  const eventsInRenderOrder = sortByRender(proxies)

  // Group overlapping events, while keeping order.
  // Every event is always one of: container, row or leaf.
  // Containers can contain rows, and rows can contain leaves.
  const containerEvents = []
  const namedContainerEvents = {}

  for (let i = 0; i < eventsInRenderOrder.length; i++) {
    const event = eventsInRenderOrder[i]

    // Check if this event can go into a container event.
    let container
    if (event.eventType) {
      let matrix = namedContainerEvents[event.eventType]
      if (!matrix) {
        event.column = 0
        matrix = [[event, null, null]]
        namedContainerEvents[event.eventType] = matrix
        continue
      }

      // look for open slot in the current matrix w/ smallest overlap and smallest gap
      for (let r = 0; r <= matrix.length; r++) {
        if (r === matrix.length) {
          matrix.push([null, null, null])
        }
        let bestCol = -1
        let bestGap = -99999
        for (let c = 0; c < 3; c++) {
          if (r === 0 && !matrix[r][c]) {
            event.column = c
            matrix[r][c] = event
            break
          }
          if (!matrix[r][c]) {
            const gap = event.start - matrix[r - 1][c].end
            if (gap > bestGap) {
              bestCol = c
              bestGap = gap
            }
          }
        }
        if (bestCol >= 0) {
          event.column = bestCol
          matrix[r][bestCol] = event
        }
        if (event.column >= 0) break
      }
      continue
    } else {
      container = containerEvents.find(
        c =>
          c.end > event.start ||
          Math.abs(event.start - c.start) < minimumStartDifference
      )
    }

    // Couldn't find a container — that means this event is a container.
    if (!container) {
      event.rows = []
      containerEvents.push(event)
      continue
    }

    // Found a container for the event.
    event.container = container

    // Check if the event can be placed in an existing row.
    // Start looking from behind.
    let row = null
    for (let j = container.rows.length - 1; !row && j >= 0; j--) {
      if (onSameRow(container.rows[j], event, minimumStartDifference)) {
        row = container.rows[j]
      }
    }

    if (row) {
      // Found a row, so add it.
      row.leaves.push(event)
      event.row = row
    } else {
      // Couldn't find a row – that means this event is a row.
      event.leaves = []
      container.rows.push(event)
    }
  }

  // Return the original events, along with their styles.
  return eventsInRenderOrder.map(event => ({
    event: event.data,
    style: {
      top: event.top,
      height: event.height,
      width: event.width,
      xOffset: event.xOffset,
    },
  }))
}

export { getStyledEvents }
