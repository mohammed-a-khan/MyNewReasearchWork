@api
Feature: Price quotes
  The public quote API prices a quantity of a product.

  Scenario: Quote from a JSON request
    When I post this quote request:
      """json
      { "sku": "SKU-100", "qty": 2 }
      """
    Then the quote total is 39.98
    And the quote is for "Widget"

  # EZTest extension: the Examples rows come from a data file (csv, xlsx, json) or a named query.
  Scenario Outline: Quote <qty> x <sku>
    When I request a quote for <qty> of "<sku>"
    Then the quote total is <total>

    Examples: from data "data/quotes.csv" where qty > 1
