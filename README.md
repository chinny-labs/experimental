# experimental

A collection of small experimental web apps, served with GitHub Pages. Each app lives in its own directory, and `index.html` at the root links to all of them.

| App | Description |
| --- | --- |
| [`pitch-trainer/`](pitch-trainer/) | Ear training for perfect pitch (name a note) and relative pitch (name an interval). |

## Adding an app

1. Create a new directory, for example `my-app/`, with an `index.html`.
2. Add a card for it to the list in the root `index.html`.
3. Add a row to the table above.

Apps are plain static files with no build step, so a directory with an `index.html` is all GitHub Pages needs.

## Running locally

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

## Publishing

In the repository's **Settings → Pages**, set **Source** to "Deploy from a branch", then choose the `main` branch and the `/ (root)` folder. The site is served at `https://<owner>.github.io/experimental/`.
