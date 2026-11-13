// Copyright 2026 The SimpBrowser Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/renderer/simpbrowser_youtube.h"

#include <string>

#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "chrome/grit/renderer_resources.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_element.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/public/web/web_script_source.h"
#include "ui/base/resource/resource_bundle.h"
#include "url/gurl.h"

namespace {

bool IsYouTube(const GURL& url) {
  return url.SchemeIs("https") &&
         (url.DomainIs("youtube.com") || url.DomainIs("youtube-nocookie.com"));
}

}  // namespace

void InstallSimpBrowserYouTube(blink::WebLocalFrame* frame) {
  const GURL url = frame->GetDocument().Url();
  if (!IsYouTube(url)) {
    return;
  }

  const std::string script =
      ui::ResourceBundle::GetSharedInstance().LoadDataResourceString(
          IDR_SIMPBROWSER_YOUTUBE_JS);
  frame->ExecuteScript(
      blink::WebScriptSource(blink::WebString::FromUtf8(script)));
}

bool BlockSimpBrowserYouTubeRequest(blink::WebLocalFrame* frame,
                                    const GURL& target) {
  if (!frame || !IsYouTube(frame->GetDocument().Url()) ||
      !target.SchemeIsHTTPOrHTTPS()) {
    return false;
  }
  blink::WebElement root = frame->GetDocument().DocumentElement();
  if (root.IsNull() || root.GetAttribute(blink::WebString::FromUtf8(
                           "data-simpbrowser-ad-policy")) != "on") {
    return false;
  }
  const auto path = target.path();
  const bool youtube_ad =
      target.DomainIs("youtube.com") &&
      (base::StartsWith(path, "/pagead/") || path == "/api/stats/ads" ||
       base::StartsWith(path, "/api/stats/ads/"));
  if (!youtube_ad && !target.DomainIs("doubleclick.net") &&
      !target.DomainIs("googlesyndication.com") &&
      !target.DomainIs("googleadservices.com")) {
    return false;
  }
  const auto counter =
      blink::WebString::FromUtf8("data-simpbrowser-native-blocks");
  uint64_t count = 0;
  if (!base::StringToUint64(root.GetAttribute(counter).Utf8(), &count)) {
    count = 0;
  }
  if (count < 1000000) {
    root.SetAttribute(
        counter, blink::WebString::FromUtf8(base::NumberToString(count + 1)));
  }
  return true;
}
