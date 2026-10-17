# diffcheck
Simple self-hostable text diff checker. The comparison runs entirely in the browser;
the server only serves five static files and the `diff` (jsdiff) browser bundle.

![Example screenshot](screenshot.png)

## Deploy with Docker

``` sh
docker run -p 127.0.0.1:10300:10300 tannisroot/diffcheck:latest
```

## LLM usage notice

This was entirely vibe-coded with Claude Sonnet 5.5 at Medium due to lack of decent, simple self-hosted alternatives to diffchecker.com.
Use at your own peril!
