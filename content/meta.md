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

"teaches the people who own them next" is lifted from the Work section, so the card
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

## og:image:alt  (all pages)

    Granite spires above a still alpine lake at first light.

Describes what is depicted without asserting it is a photograph of a real place. The
hero is generated, and the readout's "After Titcomb Basin" is meant in the
art-historical sense.

## og:title

Left as the name (`Shane Haynes`; `Shane Haynes · Record`). On X the title is overlaid
on the image and is the only text; on Slack it sits directly under the domain
shanehaynes.com. Lengthening it only repeats the domain. The description carries the
distinguishing detail.

## Known limit

The hero poster has no person in it, X strips descriptions from large-image cards, and
iMessage usually renders none. **Slack is the only surface where the full description
lands.** On X the card is a mountain, a name and a domain; no meta tag changes that.
If X ever becomes a channel worth serving, the answer is a second image, not more tags.

## Off-site copy, kept here so it stays consistent

GitHub bio:

    Builds production AI systems and teaches the people who own them next. MBA at Yale SOM.

Substack publication `Shane Haynes`, description:

    Essays and the occasional poem, written to find the hole in the third paragraph.

Built from the Writing section — "An argument that feels whole in my head usually has a
hole in the third paragraph, and I only find it by writing the third paragraph" — and
accurate to the archive: two essays and one poem.
