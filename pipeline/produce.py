"""Generic fruit & vegetable items, matched by name across chains.

Produce is sold by weight under chain-specific internal codes, so barcodes
can't be compared. Each generic item below matches weighted items by name;
a store's price for it is the cheapest matching item (per kg).
"""
from __future__ import annotations

import re

# Words that mean "not fresh produce" (processed, dried, juice, snacks...).
EXCLUDE = re.compile(
    r"מיובש|מסוכר|ציפס|צ'יפס|מחית|מיץ|רסק|מרוסק|קפוא|חמוץ|חמוצ|בחומץ|כבוש|ממולא|סלט|מבושל|"
    r"קלוי|אפוי|מטוגן|פירה|רוטב|ממרח|ריבה|שימורים|מרק|תבלין|אבקה|גרוס|קצוץ|חטיף|עוגה|מאפה|"
    r"במבה|סוכרי|שוקו|יוגורט|משקה|נקטר|תרכיז|פתיתי|פרוס|גמדי|מגורד|מקולף|שטוף ארוז|טחון|"
    r"אורגני|ביו|ספירולינה|גרעינ|במלח|שבבים|טבעות|מוחמצ|בטעמים|ברביקיו|כבושים|מעושן|בשמן|בתיבול|"
    r"פיקנטי|חריף|ממותק|קנדי"
)

# key, display name, aliases (for search), include regex (name start)
PRODUCE: list[tuple[str, str, str, str]] = [
    ("tomato", "עגבניות", "עגבניה עגבנייה", r"^עגבני(ה|יה|ות)(?!.*(שרי|תמר|לובלו|ענבי|מגי|צהוב|ירוק))"),
    ("cherry_tomato", "עגבניות שרי", "שרי", r"^עגבני.*שרי"),
    ("cucumber", "מלפפונים", "מלפפון", r"^מלפפו(ן|נים)(?!.*(בייבי|מיני))"),
    ("potato", "תפוחי אדמה", 'תפו"א תפוח אדמה', r'^(תפו"א|תפוח אדמה|תפוחי אדמה|תפ"א)(?!.*(מתוק|ירושלמי|בייבי))'),
    ("sweet_potato", "בטטה", "בטטות", r"^בטט(ה|ות)"),
    ("onion", "בצל יבש", "בצל", r"^בצל(?!.*(ירוק|סגול|אדום|שאלוט|פנינה))"),
    ("red_onion", "בצל סגול", "בצל אדום", r"^בצל (סגול|אדום)"),
    ("carrot", "גזר", "", r"^גזר(?!.*(בייבי|מיני))"),
    ("red_pepper", "פלפל אדום", "גמבה", r"^(פלפל|גמבה) אדו"),
    ("yellow_pepper", "פלפל צהוב", "", r"^(פלפל|גמבה) צהוב"),
    ("green_pepper", "פלפל ירוק", "", r"^פלפל ירוק"),
    ("zucchini", "קישואים", "קישוא", r"^קישוא"),
    ("eggplant", "חצילים", "חציל", r"^חציל"),
    ("cabbage", "כרוב לבן", "כרוב", r"^כרוב(?!.*(אדום|סגול|ניצנים|קלה))"),
    ("red_cabbage", "כרוב אדום", "כרוב סגול", r"^כרוב (אדום|סגול)"),
    ("cauliflower", "כרובית", "", r"^כרובית"),
    ("broccoli", "ברוקולי", "", r"^ברוקולי"),
    ("garlic", "שום", "", r"^שום(?!.*(כתוש|שמיר))"),
    ("lemon", "לימון", "לימונים", r"^לימון"),
    ("avocado", "אבוקדו", "", r"^אבוקדו"),
    ("banana", "בננות", "בננה", r"^בננ(ה|ות)"),
    ("apple", "תפוחי עץ", "תפוח עץ תפוחים גאלה פינק ליידי סמיט גרני", r"^תפוח(י|ים)? ?(עץ|גאלה|פינק|סמיט|גרני|זהוב|יונתן|חרמון|אדום|ירוק|סטרקינג|פוג'י|ענבר)"),
    ("pear", "אגסים", "אגס", r"^אגס"),
    ("orange", "תפוזים", "תפוז", r"^תפוז"),
    ("clementine", "קלמנטינות", "קלמנטינה מנדרינה אורי", r"^(קלמנטינ|מנדרינ|אורי\b|אור\b)"),
    ("grapefruit", "אשכוליות", "אשכולית", r"^אשכולי"),
    ("grapes", "ענבים", "ענב", r"^ענב(ים)?"),
    ("watermelon", "אבטיח", "", r"^אבטיח"),
    ("melon", "מלון", "", r"^מלון"),
    ("peach", "אפרסקים / נקטרינות", "אפרסק נקטרינה", r"^(אפרסק|נקטרינ)"),
    ("plum", "שזיפים", "שזיף", r"^שזיפ"),
    ("strawberry", "תותים", "תות שדה", r"^תות(ים)?( שדה)?\b"),
    ("mango", "מנגו", "", r"^מנגו"),
    ("kiwi", "קיווי", "", r"^קיווי"),
    ("pomegranate", "רימונים", "רימון", r"^רימו(ן|נים)"),
    ("persimmon", "אפרסמון", "", r"^אפרסמו"),
    ("celery", "סלרי", "", r"^סלרי"),
    ("beet", "סלק", "", r"^סלק"),
    ("kohlrabi", "קולורבי", "", r"^קולורבי"),
    ("corn", "תירס", "", r"^תירס"),
    ("mushroom", "פטריות", "שמפיניון", r"^(פטריות|שמפיניון)"),
    ("radish", "צנונית", "צנון", r"^צנו(נית|ן)"),
    ("fennel", "שומר", "", r"^שומר\b"),
    ("pumpkin", "דלעת", "", r"^דלעת"),
]
_COMPILED = [(key, re.compile(rx)) for key, _, _, rx in PRODUCE]
MAX_PRICE_PER_KG = 60.0  # absolute ceiling (used by the build as a first filter)
_PRICEY = {"garlic", "mushroom", "strawberry", "cherry_tomato", "grapes", "kiwi", "mango"}


def max_price(key: str) -> float:
    """Above this price per kg the item is almost surely not plain fresh produce."""
    return 50.0 if key in _PRICEY else 30.0


def norm_name(name: str) -> str:
    name = re.sub(r"\s+", " ", name or "").strip()
    name = re.sub(r"^(ירקות|פירות)\s*[-:]?\s*", "", name)
    return name


def match(name: str) -> str | None:
    """Return the generic produce key for a weighted item name, or None."""
    n = norm_name(name)
    if not n or EXCLUDE.search(n):
        return None
    for key, rx in _COMPILED:
        if rx.search(n):
            return key
    return None


def catalog_entries() -> dict[str, list]:
    """barcode-style catalog entries for the generic items (code 'P:<key>')."""
    return {
        f"P:{key}": [f"{name} (לק״ג)", "פירות וירקות", "", 1, 0, aliases]
        for key, name, aliases, _ in PRODUCE
    }
