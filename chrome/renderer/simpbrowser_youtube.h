// Copyright 2026 The SimpBrowser Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_RENDERER_SIMPBROWSER_YOUTUBE_H_
#define CHROME_RENDERER_SIMPBROWSER_YOUTUBE_H_

class GURL;

namespace blink {
class WebLocalFrame;
}

// Installs an unprivileged bundled page script only on HTTPS YouTube frames.
void InstallSimpBrowserYouTube(blink::WebLocalFrame* frame);

// Checks known ad destinations only after the page module opts this frame in.
// Records a bounded counter on the document, without retaining request URLs.
bool BlockSimpBrowserYouTubeRequest(blink::WebLocalFrame* frame,
                                    const GURL& target);

#endif  // CHROME_RENDERER_SIMPBROWSER_YOUTUBE_H_
