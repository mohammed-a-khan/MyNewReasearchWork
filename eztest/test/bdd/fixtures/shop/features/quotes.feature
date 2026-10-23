@shop @api
Feature: Price quotes
  The public quote API prices a quantity of a product.

  Rule: Quotes are priced per unit

    Scenario: Quote for a gadget
      When I request a quote for 3 of "SKU-200"
      Then the quote total is 148.50
      And the quote is for "Gadget"

    Scenario: Quote from a JSON request
      When I post this quote request:
        """json
        { "sku": "SKU-100", "qty": 2 }
        """
      Then the quote total is 39.98

  Rule: Quotes for many products

    Scenario Outline: Quote <sku> x <qty> from a CSV file
      When I request a quote for <qty> of "<sku>"
      Then the quote total is <total>

      @csv
      Examples: from data "data/quotes.csv" where qty > 1

    Scenario Outline: Quote <sku> x <qty> from a workbook
      When I request a quote for <qty> of "<sku>"
      Then the quote total is <total>

      @xlsx
      Examples: from data "data/quotes.xlsx" sheet "Quotes"
