# Cucumber feature used by the importer replay test.
@shop
Feature: EZ Shop orders
  Managers can create orders from the order form.

  Background:
    Given I open /login
    When I type "bob" into the Username field
    And I type "Builder#2" into the Password field
    And I click the "Sign in" button
    Then the URL contains "/dashboard"
    And I should see "Welcome"

  @smoke @orders
  Scenario Outline: Bob orders <qty> x <product>
    When I go to /orders/new
    And I select "<product>" from the Product dropdown
    And I fill the Quantity field with <qty>
    And I click the "Submit order" button
    Then I should see "created"
    And testid=order-total has text "<total>"
    And the order is persisted in the ERP

    Examples:
      | product        | qty | total |
      | Gadget (49.50) | 2   | 99.00 |
      | Widget (19.99) | 3   | 59.97 |

  Scenario: Sign-in page lists credentials fields
    Given I open /login
    Then the page contains:
      """
      Sign in to EZ Shop
      """
    And the following fields are shown:
      | field    |
      | Username |
      | Password |
