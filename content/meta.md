# Preview copy (source of truth)

These strings are what a stranger sees before the site loads: the Slack/iMessage
unfurl, the search snippet, the browser tab. The old homepage description —
"Shane Haynes. Philosopher Builder. Work, writing, mountains, philosophy." — was a
table of contents where a person should be, and nothing in it separated this Shane
Haynes from the physician and the actor who fill the search results.

Rule: on every page, `meta name="description"` and `og:description` carry the
**same string, byte for byte**. They had already drifted apart inside index.html.
Identical-by-rule makes a one-sided edit visible in the diff.

## index.html  (122 chars)

    Shane Haynes builds production AI systems and teaches the people who own them next. MBA at Yale SOM, formerly Eide Bailly.

"teaches the people who own them next" restates the record's upskilling sentence and Work's "I trained my successors", so the card
still sounds like the site. All three disambiguators — AI systems, Yale SOM, Eide
Bailly — land before Slack's clamp.

## record.html  (96 chars)

    Shane Haynes, in full: University of Utah and Yale SOM, Eide Bailly, projects and certifications.

The page is `noindex`, so this string serves unfurls only — Slackbot and Apple's
LinkPresentation ignore `noindex` and render the card anyway. It orients a person who
has just been handed the link, which is usually a recruiter or a classmate.

## personal.html

Carries the index.html string verbatim. The file is a redirect to `/#mountains`, not
a destination, so it should preview as the page it forwards to.

## og:image  (all pages, since 2026-09-16)

    https://shanehaynes.com/media/yale-card.jpg   1200 x 630

A 1.91:1 band cut from the studio headshot (`images/yalePortrait.png`), eyes in the upper
third. Replaces the hero poster, which had no person in it. The poster's frame stays the
`<video poster>` and the hero background; only the preview card changed.

## og:image:alt  (all pages)

    Shane Haynes, in a dark suit and navy tie, looking straight at the camera.

The previous alt, "Granite spires above a still alpine lake at first light.", described
the generated hero without asserting it was a photograph; it is kept here for the record.

## og:title

Left as the name (`Shane Haynes`; `Shane Haynes · Record`). On X the title is overlaid
on the image and is the only text; on Slack it sits directly under the domain
shanehaynes.com. Lengthening it only repeats the domain. The description carries the
distinguishing detail.

## Known limit

X strips descriptions from large-image cards, and iMessage usually renders none.
**Slack is the only surface where the full description lands.** Since 2026-09-16 the card
is a face, a name and a domain rather than a mountain, which is what those surfaces can
carry; the description still only lands on Slack.

## Off-site copy, kept here so it stays consistent

GitHub bio:

    Builds production AI systems and teaches the people who own them next. MBA at Yale SOM.

Substack publication `Shane Haynes`, description:

    Essays and the occasional poem, written to find the hole in the third paragraph.

Built from the Writing section — "An argument that feels whole in my head usually has a
hole in the third paragraph, and I only find it by writing the third paragraph" — and
accurate to the archive: two essays and one poem.
