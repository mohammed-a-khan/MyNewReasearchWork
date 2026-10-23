@shop @ui
Feature: Ordering in the EZ Shop
  Sales staff order products for customers.
  The sign-in uses EZTest phrasings only: no glue code.

  Background:
    Given I am on "/login"
    When I type "bob" into the "Username" field
    And I type "Builder#2" into the "Password" field
    And I click the "Sign in" button
    Then the URL contains "/dashboard"

  @smoke @req:REQ-BDD-1
  Scenario: Place an order through the UI
    When I order 3 "Gadget (49.50)" for "Contoso Ltd"
    Then the page contains "created"
    And the order total is 148.50
    And the database has 1 order for "Contoso Ltd"

  Scenario: EU customers come from the database
    Then the EU customers are:
      | name              | credit_limit |
      | Contoso Ltd       | 25000        |
      | Northwind Traders | 12000        |

  Scenario Outline: Signed in as <user>
    Given I am on "/dashboard"
    Then the page contains "Welcome, <user>"
    And the "Recent orders" table is visible

    @inline
    Examples:
      | user |
      | bob  |
