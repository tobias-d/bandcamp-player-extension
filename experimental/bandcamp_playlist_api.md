# Bandcamp Playlist API

Reverse-engineered via Proxyman + Android emulator traffic capture.  
All endpoints are undocumented and unofficial.

---

## Base URL

```
https://bandcamp.com
```

---

## Authentication

Requests must be made from the browser context with `credentials: "include"` — the user's Bandcamp session cookies are sent automatically.

No manual auth headers needed in the browser extension. The following cookies are required (handled automatically):

- `client_id` — device/session identifier
- `BACKENDID3` — backend routing cookie

When replaying requests via curl or outside the browser, you also need:

```
Authorization: Bearer <token>
```

---

## Endpoints

### 1. Fetch all playlists

Retrieves all playlists for the logged-in user, including their full track lists.

```
POST /api/playlist/1/fetch
```

**Request body:**

```json
{
  "newer_than_token": "0:0"
}
```

Use `"0:0"` to fetch everything from scratch. For incremental sync, pass the `newest_token` value from the previous response.

**Response:**

```json
{
  "items": [
    {
      "id": 881795,
      "acct_type": "f",
      "acct_id": 7918743,
      "new_date": 1780598974,
      "mod_date": 1782331073,
      "is_private": true,
      "title": "Mix2",
      "description": null,
      "image_id": null,
      "token": "1782331073:881795",
      "url": "https://bandcamp.com/lani_d/playlist/mix2",
      "items": [
        {
          "id": 33387389,
          "item_id": 373200785,
          "item_type": "t",
          "item_index": 0,
          "item_note": null,
          "item_note_bg_color": null
        }
      ]
    }
  ],
  "deletions": [],
  "newest_token": "",
  "sync_date": 1782331605
}
```

**Key fields:**

| Field | Description |
|---|---|
| `items[].id` | Playlist ID |
| `items[].title` | Playlist name |
| `items[].is_private` | Privacy setting |
| `items[].token` | Used for auth on save operations — format: `timestamp:playlist_id` |
| `items[].items[].item_id` | Track ID |
| `items[].items[].item_type` | Always `"t"` for tracks |
| `items[].items[].item_index` | Position in playlist (0-based) |
| `newest_token` | Pass this as `newer_than_token` on next sync to get only changes |
| `sync_date` | Unix timestamp of this response |

---

### 2. Create a new playlist

```
POST /api/playlist/1/save
```

**Request body:**

```json
{
  "playlist": {
    "is_private": true,
    "items": [],
    "title": "My New Playlist"
  }
}
```

No `id` field — the server assigns it and returns it in the response.

---

### 3. Add a track to a playlist

The API uses a **full replace** model — you always send the complete items array, not just the new track.

```
POST /api/playlist/1/save
```

**Request body:**

```json
{
  "playlist": {
    "id": 881795,
    "is_private": true,
    "title": "Mix2",
    "items": [
      { "id": 33387389, "item_id": 373200785, "item_type": "t" },
      { "id": 33387396, "item_id": 1599383214, "item_type": "t" },
      { "item_id": 9999999999, "item_type": "t" }
    ]
  }
}
```

The new track is appended at the end **without an `id` field** — the server assigns it.

---

### 4. Remove a track from a playlist

Same endpoint and structure as adding — just send the full items array with the target track omitted.

```
POST /api/playlist/1/save
```

---

## Implementation in browser extension

```javascript
// Fetch all playlists
async function fetchPlaylists() {
  const res = await fetch("https://bandcamp.com/api/playlist/1/fetch", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newer_than_token: "0:0" })
  });
  return res.json();
}

// Add a track to a playlist
async function addTrackToPlaylist(playlist, trackId) {
  const updatedItems = [
    ...playlist.items.map(({ id, item_id, item_type }) => ({ id, item_id, item_type })),
    { item_id: trackId, item_type: "t" }
  ];

  const res = await fetch("https://bandcamp.com/api/playlist/1/save", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      playlist: {
        id: playlist.id,
        is_private: playlist.is_private,
        title: playlist.title,
        items: updatedItems
      }
    })
  });
  return res.json();
}

// Remove a track from a playlist
async function removeTrackFromPlaylist(playlist, itemId) {
  const updatedItems = playlist.items
    .filter(item => item.id !== itemId)
    .map(({ id, item_id, item_type }) => ({ id, item_id, item_type }));

  const res = await fetch("https://bandcamp.com/api/playlist/1/save", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      playlist: {
        id: playlist.id,
        is_private: playlist.is_private,
        title: playlist.title,
        items: updatedItems
      }
    })
  });
  return res.json();
}

// Create a new playlist
async function createPlaylist(title, isPrivate = true) {
  const res = await fetch("https://bandcamp.com/api/playlist/1/save", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      playlist: { title, is_private: isPrivate, items: [] }
    })
  });
  return res.json();
}
```

---

## Notes

- The API uses a **full replace** model for saves — always fetch the current playlist first, modify the items array in memory, then save the whole thing back.
- `item_type: "t"` means track. Other types may exist (e.g. albums) but have not been confirmed.
- The `newer_than_token` sync pattern lets you poll for changes efficiently without re-fetching everything.
- The `token` field on each playlist (`timestamp:playlist_id`) appears in responses but is not required in save request bodies.
- These are undocumented endpoints — they may change without notice.
