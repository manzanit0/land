# land

A Firefox new-tab page for GitHub pull request triage: what's ready to
land, what's waiting on your review, what's stuck on others — plus a
bookmarks bar. Data comes straight from the GitHub search API using a
personal access token you provide on first run; everything is stored
locally in the browser.

## Install

Bundle the add-on:

```sh
task bundle
```

Then load it in Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick the generated
   `land-<version>.xpi` (or `manifest.json` in this directory).
3. Open a new tab.

Temporary add-ons are removed when Firefox restarts. For a permanent
install, upload the `.xpi` to [addons.mozilla.org](https://addons.mozilla.org/developers/)
as an unlisted add-on and install the signed file it returns.

## No add-on at all

Alternatively, copy `index.html` and `app.js` into any local directory
and open `index.html` in the browser — the page works as a plain file.
Bookmark its `file://` URL, or set it as your Firefox homepage
(Settings → Home → Custom URLs). Note that the browser stores the
token and bookmarks per location, so moving the files means entering
them again.
