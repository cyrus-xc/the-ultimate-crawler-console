"""Normalize recorded Douyin web responses into flat rows.

Column names follow the XHS raw CSVs (``pipeline/KolPerformance`` raw/*.csv)
wherever the meaning is the same, so the KolPerformance statistic/score logic
can later be pointed at Douyin rows; Douyin-only fields get new columns.
Every mapping here was taken from responses recorded in
``runs/douyin_smoke_001/probe`` (2026-10-04), not from documentation.

    XHS column        Douyin source
    user_id           user.sec_uid   (stable id used in every web URL)
    red_id            user.unique_id (抖音号, the public handle)
    followers         user.follower_count (Douyin app only; see followers_all_platforms)
    note_count        user.aweme_count
    note_id           aweme.aweme_id
    liked_count       statistics.digg_count
    collected_count   statistics.collect_count
    comment_count     statistics.comment_count
    shared_count      statistics.share_count
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import parse_qs, urlparse

_HEX_EXPIRY = re.compile(r"/[0-9a-f]{32}/([0-9a-f]{8})/")


def url_expiry(url: str | None) -> int | None:
    """Epoch seconds a signed CDN URL stops working, if the URL says.

    Images carry ``x-expires=``; ``douyinvod.com`` video URLs carry it as the
    hex path segment after the 32-char signature (observed: both encode the
    same epoch, ~3.2 h after capture for video, ~14 d for covers).
    """
    if not url:
        return None
    q = parse_qs(urlparse(url).query)
    if "x-expires" in q:
        try:
            return int(q["x-expires"][0])
        except ValueError:
            return None
    m = _HEX_EXPIRY.search(url)
    return int(m.group(1), 16) if m else None


def _first_url(container: Any) -> str | None:
    if isinstance(container, dict):
        urls = [u for u in (container.get("url_list") or []) if isinstance(u, str) and u]
        return urls[0] if urls else None
    return None


def _strip_ip_prefix(value: str | None) -> str | None:
    if not value:
        return None
    return value.replace("IP属地：", "").replace("IP属地:", "").strip() or None


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def user_row(user: dict, *, source_type: str) -> dict:
    """``user/profile/other`` user (full) or an aweme's ``author`` (partial).

    The two disagree on follower counts: the profile reports ``follower_count``
    (Douyin only) plus ``mplatform_followers_count`` (incl. sister apps), while
    search/feed ``author.follower_count`` already equals the all-platform
    number (observed 1,490,228 vs 1,656,908 for the same creator).
    """
    followers = user.get("follower_count")
    all_platforms = user.get("mplatform_followers_count")
    if source_type != "profile":
        followers, all_platforms = None, followers
    return {
        "user_id": user.get("sec_uid"),
        "uid": user.get("uid"),
        "red_id": user.get("unique_id") or user.get("short_id"),
        "nickname": user.get("nickname"),
        "avatar": _first_url(user.get("avatar_larger") or user.get("avatar_thumb")),
        "ip_location": _strip_ip_prefix(user.get("ip_location")),
        "province": user.get("province") or None,
        "city": user.get("city") or None,
        "gender": user.get("gender"),
        "user_age": user.get("user_age") if (user.get("user_age") or 0) > 0 else None,
        "followers": followers,
        # Douyin + 今日头条: the gap only appeared on accounts with
        # sync_to_toutiao=1 in the 2026-10-04 sample (西瓜 not verified)
        "followers_all_platforms": all_platforms,
        "sync_to_toutiao": user.get("sync_to_toutiao") if source_type == "profile" else None,
        "max_follower_count": user.get("max_follower_count") if source_type == "profile" else None,
        "following": user.get("following_count"),
        "note_count": user.get("aweme_count"),
        "total_liked": user.get("total_favorited"),
        "profile_bio": user.get("signature"),
        "verify_custom": user.get("custom_verify") or None,
        "verify_enterprise": user.get("enterprise_verify_reason") or None,
        "verification_type": user.get("verification_type"),
        "seller_info_flag": user.get("with_commerce_entry"),
        "brand_account_flag": bool(user.get("enterprise_verify_reason")),
        "is_star": user.get("is_star"),
        "live_status": user.get("live_status"),
        "mix_count": user.get("mix_count"),
        "series_count": user.get("series_count"),
        "source_type": source_type,
        "raw_json": _dumps(user),
    }


def _is_star_atlas(aweme: dict) -> bool:
    """星图 (paid placement) marker. Observed only as
    ``star_atlas_info.log_extra == '{"is_star": true}'``; ``star_atlas_order_id``
    stayed null in every sample, so both are checked."""
    if aweme.get("star_atlas_order_id"):
        return True
    extra = (aweme.get("star_atlas_info") or {}).get("log_extra")
    if isinstance(extra, str):
        try:
            return bool(json.loads(extra).get("is_star"))
        except ValueError:
            return False
    return False


def _poi(aweme: dict) -> dict:
    """The restaurant/place tag. Observed in two places: ``poi_info`` (feed,
    related videos) and, on profile lists and detail pages where ``poi_info``
    is always empty, an ``anchor_info`` of type 2 whose ``extra`` JSON string
    carries the same POI object (61% of smoke-run profile posts)."""
    if aweme.get("poi_info"):
        return aweme["poi_info"]
    anchor = aweme.get("anchor_info") or {}
    if anchor.get("type") == 2 and isinstance(anchor.get("extra"), str):
        try:
            return json.loads(anchor["extra"])
        except ValueError:
            return {}
    return {}


def aweme_row(aweme: dict, *, source_endpoint: str) -> dict:
    stats = aweme.get("statistics") or {}
    video = aweme.get("video") or {}
    author = aweme.get("author") or {}
    poi = _poi(aweme)
    poi_addr = poi.get("address_info") or {}
    music = aweme.get("music") or {}
    chapter = aweme.get("recommend_chapter_info") or {}
    play_url = _first_url(video.get("play_addr"))
    # audio-only DASH stream (1-3 variants per post when present); signed,
    # ~24 h lifetime. Take the lightest variant: the first one is often the
    # 194 kbps "normal" track where a 51-63 kbps one exists (STT needs 16 kHz mono).
    audio_url, audio_bytes, audio_bitrate = None, None, None
    for entry in video.get("bit_rate_audio") or []:
        meta = (entry or {}).get("audio_meta") or {}
        urls = meta.get("url_list") or {}
        url = urls.get("main_url") or urls.get("backup_url") if isinstance(urls, dict) else None
        if url and (audio_bitrate is None or (meta.get("bitrate") or 0) < audio_bitrate):
            audio_url, audio_bytes, audio_bitrate = url, meta.get("size"), meta.get("bitrate") or 0
    cover_url = _first_url(video.get("origin_cover") or video.get("cover"))
    music_url = _first_url(music.get("play_url"))
    images = aweme.get("images") or []
    hashtags = [t.get("hashtag_name") for t in aweme.get("text_extra") or [] if t.get("hashtag_name")]
    video_tags = [t.get("tag_name") for t in sorted(aweme.get("video_tag") or [], key=lambda t: t.get("level") or 0) if t.get("tag_name")]
    co_creators = [c.get("nickname") for c in (aweme.get("cooperation_info") or {}).get("co_creators") or []]
    return {
        "note_id": aweme.get("aweme_id"),
        "user_id": author.get("sec_uid"),
        "author_nickname": author.get("nickname"),
        "note_type": "image" if images else "video",
        "aweme_type": aweme.get("aweme_type"),
        "title": aweme.get("item_title") or None,
        "desc": aweme.get("desc"),
        "create_time": aweme.get("create_time"),
        "duration_ms": aweme.get("duration") or video.get("duration"),
        "is_top": bool(aweme.get("is_top")),
        "liked_count": stats.get("digg_count"),
        "collected_count": stats.get("collect_count"),
        "comment_count": stats.get("comment_count"),
        "shared_count": stats.get("share_count"),
        "play_count": stats.get("play_count") or None,  # 0 for other people's videos on web
        "recommend_count": stats.get("recommend_count"),
        "hash_tags": _dumps(hashtags),
        "video_tags": " > ".join(video_tags) or None,
        "chapter_abstract": chapter.get("chapter_abstract") or aweme.get("chapter_abstract") or None,
        "chapters": _dumps([{"t": c.get("timestamp"), "desc": c.get("desc")} for c in chapter.get("recommend_chapter_list") or []]) if chapter.get("recommend_chapter_list") else None,
        "native_caption_text": _dumps(aweme.get("video_text")) if aweme.get("video_text") else None,
        "poi_id": poi.get("poi_id"),
        "poi_name": poi.get("poi_name"),
        "poi_address": poi_addr.get("address"),
        "poi_city": poi_addr.get("city"),
        "poi_district": poi_addr.get("district"),
        "poi_lat": poi.get("poi_latitude"),
        "poi_lng": poi.get("poi_longitude"),
        "poi_category": (poi.get("poi_backend_type") or {}).get("name"),
        "poi_rank_text": poi.get("poi_subtitle"),
        "poi_group_buy": poi.get("is_food_group_buy"),
        "poi_cost": poi.get("cost"),
        "poi_cps_commission_rate_range": _dumps(poi["cps_commission_rate_range"]) if poi.get("cps_commission_rate_range") else None,
        "anchor_type": (aweme.get("anchor_info") or {}).get("type"),
        "anchor_title": (aweme.get("anchor_info") or {}).get("title"),
        "cooperate_binds_flag": _is_star_atlas(aweme),
        "is_ads": aweme.get("is_ads"),
        "co_creators": _dumps(co_creators) if co_creators else None,
        "ip_location": _strip_ip_prefix(aweme.get("ip_attribution")),
        "share_url": f"https://www.douyin.com/video/{aweme.get('aweme_id')}",
        "cover_url": cover_url,
        "cover_url_expires": url_expiry(cover_url),
        "play_url": play_url,
        "play_url_expires": url_expiry(play_url),
        "audio_url": audio_url,
        "audio_url_expires": url_expiry(audio_url),
        "audio_url_bytes": audio_bytes,
        "audio_url_bitrate": audio_bitrate or None,
        "video_uri": (video.get("play_addr") or {}).get("uri"),
        "music_title": music.get("title"),
        "music_play_url": music_url,
        "music_is_original_sound": bool(music.get("author") and music.get("author") == author.get("nickname")),
        "image_count": len(images) or None,
        "source_endpoint": source_endpoint,
        "raw_json": _dumps(aweme),
    }


def comment_row(comment: dict, *, aweme_id: str, cursor: Any) -> dict:
    user = comment.get("user") or {}
    return {
        "note_id": aweme_id,
        "comment_id": comment.get("cid"),
        "parent_comment_id": comment.get("reply_id") if comment.get("reply_id") not in (None, "0") else None,
        "cursor": cursor,
        "comment_user_id": user.get("sec_uid"),
        "comment_user_nickname": user.get("nickname"),
        "comment_text": comment.get("text"),
        "like_count": comment.get("digg_count"),
        "comment_time": comment.get("create_time"),
        "is_sub_comment": comment.get("level", 1) != 1,
        "sub_comment_count": comment.get("reply_comment_total"),
        "commenter_ip_location": comment.get("ip_label") or None,
        "is_hot": comment.get("is_hot"),
        "is_author_digged": comment.get("is_author_digged"),
        "raw_json": _dumps(comment),
    }


def awemes_in(endpoint: str, body: dict) -> list[dict]:
    """The aweme structs a recorded response carries, by endpoint shape."""
    if endpoint.endswith("aweme_detail"):
        return [body["aweme_detail"]] if body.get("aweme_detail") else []
    if endpoint.endswith("search_item"):
        return [d["aweme_info"] for d in body.get("data") or [] if isinstance(d, dict) and d.get("aweme_info")]
    return list(body.get("aweme_list") or [])
